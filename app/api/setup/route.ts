// app/api/setup/route.ts — self-registration endpoint (server / multi-user mode only).
//
// GET  → reports whether multi-user mode is on and whether this browser already
//         has a valid session (so the setup page knows to show form vs "done").
// POST → validates input + Bugzilla key, stores the encrypted profile, and issues
//        a bt_session cookie.  Rejects all calls when MULTI_USER != "1".
//
// The inline Bugzilla key check deliberately does NOT call lib/bugzilla.ts's
// whoami() — that reads global/effective settings, not the prospective user's key.
// Phase 2 will wire bugzilla.ts to getEffectiveSettings() and can consolidate.

import { NextResponse } from "next/server";
import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";

import { upsertUser, createSession, resolveSession } from "@/lib/users/store";
import { isMultiUser } from "@/lib/settings";

export const dynamic = "force-dynamic";

// ── Cookie helper ─────────────────────────────────────────────────

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie") ?? "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

// ── GET ───────────────────────────────────────────────────────────

export async function GET(req: Request) {
  if (!isMultiUser()) {
    return NextResponse.json({ multiUser: false });
  }
  const token = readCookie(req, "bt_session");
  const hasSession = !!(token && resolveSession(token));
  return NextResponse.json({ multiUser: true, hasSession });
}

// ── POST ──────────────────────────────────────────────────────────

interface SetupBody {
  email?: unknown;
  bugzillaApiKey?: unknown;
  useCompanyLlm?: unknown;
  llmProvider?: unknown;
  llmBaseUrl?: unknown;
  llmApiKey?: unknown;
  defaultModel?: unknown;
  themeMode?: unknown;
}

export async function POST(req: Request) {
  if (!isMultiUser()) {
    return NextResponse.json({ error: "not in server mode" }, { status: 400 });
  }

  // ── Parse body ────────────────────────────────────────────────
  let body: SetupBody;
  try {
    body = (await req.json()) as SetupBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const bugzillaApiKey = typeof body.bugzillaApiKey === "string" ? body.bugzillaApiKey.trim() : "";
  const useCompanyLlm = Boolean(body.useCompanyLlm);
  const llmProvider = typeof body.llmProvider === "string" ? body.llmProvider.trim() : "";
  const llmBaseUrl = typeof body.llmBaseUrl === "string" ? body.llmBaseUrl.trim() : "";
  const llmApiKey = typeof body.llmApiKey === "string" ? body.llmApiKey.trim() : "";
  const defaultModel = typeof body.defaultModel === "string" ? body.defaultModel.trim() : "";
  const themeMode = typeof body.themeMode === "string" ? body.themeMode.trim() : "system";

  // ── Validate ─────────────────────────────────────────────────
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "invalid email address" }, { status: 400 });
  }
  if (!bugzillaApiKey) {
    return NextResponse.json({ error: "bugzillaApiKey is required" }, { status: 400 });
  }

  // ── Validate Bugzilla key inline ──────────────────────────────
  const bzUrl = (process.env.BUGZILLA_URL ?? "").replace(/\/$/, "");
  const bzInsecure = (process.env.BUGZILLA_INSECURE ?? "").toLowerCase() === "true";

  if (!bzUrl) {
    return NextResponse.json({ error: "BUGZILLA_URL is not configured on the server" }, { status: 500 });
  }

  const keyCheck = await validateBugzillaKey(bzUrl, bugzillaApiKey, email, bzInsecure);
  if (!keyCheck.ok) {
    return NextResponse.json(
      { error: `Bugzilla key check failed: ${keyCheck.error}` },
      { status: 400 },
    );
  }

  // ── Persist profile + create session ─────────────────────────
  upsertUser({
    email,
    bugzillaApiKey,
    llmProvider: llmProvider || "anthropic",
    llmBaseUrl,
    llmApiKey: useCompanyLlm ? "" : llmApiKey,
    defaultModel,
    useCompanyLlm,
    themeMode: themeMode || "system",
  });

  const token = createSession(email);

  // ── Issue cookie ──────────────────────────────────────────────
  const res = NextResponse.json({ ok: true, email });
  res.cookies.set("bt_session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: true,
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}

// ── Inline Bugzilla key validator ─────────────────────────────────
//
// Validates the prospective user's API key against the server's Bugzilla,
// WITHOUT lib/bugzilla.ts's whoami() (that reads the effective settings, not
// this not-yet-registered key). We deliberately do NOT rely on /rest/whoami:
// it was added after Bugzilla 5.0, and internal installs that predate it (e.g.
// the one this app targets) 404 that path — which blocked registration even
// though every other endpoint the app uses works fine. Instead:
//   1. GET /rest/valid_login?login=<email> — the purpose-built check: returns
//      result:true iff the key is a valid login FOR this email, which also
//      enforces the "email must match your Bugzilla account" promise. Present
//      since Bugzilla 5.0 — a superset of installs that ship /rest/whoami.
//   2. Fallback GET /rest/user?names=<email> — the same user endpoint the app
//      uses everywhere; a 2xx with a matching user confirms key + account.
// A bad key fails both (Bugzilla returns an auth error, surfaced verbatim).

interface ValidateResult {
  ok: boolean;
  error?: string;
}

interface RawResponse { status: number; text: string; err?: string }

function validateBugzillaKey(
  baseUrl: string,
  apiKey: string,
  email: string,
  insecure: boolean,
  timeoutMs = 15_000,
): Promise<ValidateResult> {
  // Single GET against the Bugzilla REST API; resolves with status + body
  // (never rejects). Mirrors the node:https pattern from lib/bugzilla.ts.
  function get(restPath: string): Promise<RawResponse> {
    return new Promise(resolve => {
      let u: URL;
      try {
        u = new URL(`${baseUrl}${restPath}`);
      } catch {
        resolve({ status: 0, text: "", err: "BUGZILLA_URL is not a valid URL" });
        return;
      }
      u.searchParams.set("api_key", apiKey);
      const isHttps = u.protocol === "https:";
      const mod = isHttps ? https : http;
      const req = mod.request(
        {
          method: "GET",
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: `${u.pathname}${u.search}`,
          rejectUnauthorized: !insecure,
          timeout: timeoutMs,
        },
        res => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", (err: Error) => resolve({ status: 0, text: "", err: err.message }));
        },
      );
      req.on("error", (err: Error) => resolve({ status: 0, text: "", err: err.message }));
      req.on("timeout", () => { req.destroy(); resolve({ status: 0, text: "", err: `timeout after ${timeoutMs}ms` }); });
      req.end();
    });
  }

  const is2xx = (s: number) => s >= 200 && s < 300;
  const bzMessage = (text: string, status: number): string => {
    let detail = `HTTP ${status}`;
    try { const p = JSON.parse(text) as { message?: string }; if (p.message) detail += `: ${p.message}`; } catch { /* not JSON */ }
    return detail;
  };

  return (async () => {
    // 1. valid_login — definitive key+email check on installs that have it.
    const vl = await get(`/rest/valid_login?login=${encodeURIComponent(email)}`);
    if (vl.err) return { ok: false, error: vl.err };
    if (is2xx(vl.status)) {
      try {
        const d = JSON.parse(vl.text) as { result?: boolean };
        if (d.result === true) return { ok: true };
        if (d.result === false) {
          return { ok: false, error: `the API key is not a valid login for ${email} — check the key belongs to this account` };
        }
      } catch { /* unexpected shape — fall through to the user check */ }
    }

    // 2. Fallback: fetch the user's own record (works wherever the app works).
    const usr = await get(`/rest/user?names=${encodeURIComponent(email)}`);
    if (usr.err) return { ok: false, error: usr.err };
    if (is2xx(usr.status)) {
      try {
        const d = JSON.parse(usr.text) as { users?: unknown[] };
        if (Array.isArray(d.users) && d.users.length > 0) return { ok: true };
        return { ok: false, error: `key accepted but no Bugzilla account matches ${email}` };
      } catch { /* fall through to the error below */ }
    }

    // Neither succeeded — surface the most informative Bugzilla error. Prefer
    // the user-endpoint status (it reflects auth failures for a bad key).
    const pick = usr.status ? usr : vl;
    return { ok: false, error: bzMessage(pick.text, pick.status) };
  })();
}
