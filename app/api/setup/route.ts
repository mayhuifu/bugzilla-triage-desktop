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

  const keyCheck = await validateBugzillaKey(bzUrl, bugzillaApiKey, bzInsecure);
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
// Mirrors the node:https request pattern from lib/bugzilla.ts (nodeRequest)
// and app/api/settings/test/route.ts (fetchJson): construct a URL, pass
// rejectUnauthorized: !insecure, stream response chunks, JSON.parse on end.
// We call /rest/whoami because it requires a valid API key and returns a name
// — giving us both auth confirmation and a human-readable identity.

interface ValidateResult {
  ok: boolean;
  name?: string;
  error?: string;
}

function validateBugzillaKey(
  baseUrl: string,
  apiKey: string,
  insecure: boolean,
  timeoutMs = 15_000,
): Promise<ValidateResult> {
  return new Promise(resolve => {
    let settled = false;
    function done(r: ValidateResult) {
      if (!settled) { settled = true; resolve(r); }
    }

    let u: URL;
    try {
      u = new URL(`${baseUrl}/rest/whoami`);
    } catch {
      done({ ok: false, error: "BUGZILLA_URL is not a valid URL" });
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
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            // Bugzilla returns JSON error details on 400/401 — surface message if possible.
            let detail = `HTTP ${status}`;
            try {
              const parsed = JSON.parse(text) as { message?: string };
              if (parsed.message) detail += `: ${parsed.message}`;
            } catch { /* ignore */ }
            done({ ok: false, error: detail });
            return;
          }
          try {
            const data = JSON.parse(text) as { name?: string; id?: number };
            if (data.name || data.id) {
              done({ ok: true, name: data.name });
            } else {
              done({ ok: false, error: "unexpected response from /rest/whoami" });
            }
          } catch {
            done({ ok: false, error: "response was not JSON" });
          }
        });
        res.on("error", (err: Error) => done({ ok: false, error: err.message }));
      },
    );
    req.on("error", (err: Error) => done({ ok: false, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      done({ ok: false, error: `timeout after ${timeoutMs}ms` });
    });
    req.end();
  });
}
