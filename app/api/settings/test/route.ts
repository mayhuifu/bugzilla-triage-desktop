import { NextRequest, NextResponse } from "next/server";
import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";

// Settings → Test connection.
//
// The user clicks "Test connection" on the /settings page; we take the
// in-flight form values (not yet saved) and try a single small Bugzilla
// call to verify they work. Saves users a save → navigate → error →
// come-back round-trip when a credential is wrong.
//
// We don't touch the persisted settings file from here. The page sends
// whatever it currently has in the input fields — so a user can iterate
// on a key without committing each attempt to disk. The page handles the
// special case where a saved-but-not-re-typed API key field is blank by
// fetching the masked /api/settings to find out which keys are stored,
// and gating the test button on either a key in the field or a stored
// one. Here we just receive `bugzillaApiKey` and trust the page.

export const dynamic = "force-dynamic";

interface TestRequest {
  bugzillaUrl: string;
  bugzillaApiKey: string;   // page sends "" if user wants to re-test
                            // the currently-saved key — we fall back to
                            // loadSettings() in that case
  bugzillaInsecure: boolean;
}

interface TestResult {
  ok: boolean;
  message: string;
  /** Bugzilla version string (e.g. "5.0.6"), present on success */
  version?: string;
  /** Whoami login if /rest/whoami responded, useful confirmation */
  whoami?: string;
}

export async function POST(req: NextRequest) {
  let body: TestRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, message: "invalid JSON body" } satisfies TestResult,
      { status: 400 },
    );
  }

  // Fall back to the stored key if the user left the input blank — they
  // want to re-test a key they've already saved without re-typing it.
  let apiKey = body.bugzillaApiKey?.trim();
  if (!apiKey) {
    const { loadSettings } = await import("@/lib/settings");
    apiKey = loadSettings().bugzillaApiKey;
  }

  const url = (body.bugzillaUrl || "").trim().replace(/\/$/, "");
  if (!url) {
    return NextResponse.json(
      { ok: false, message: "Bugzilla URL is empty" } satisfies TestResult,
      { status: 400 },
    );
  }
  if (!/^https?:\/\//.test(url)) {
    return NextResponse.json(
      { ok: false, message: "Bugzilla URL must start with http:// or https://" } satisfies TestResult,
      { status: 400 },
    );
  }
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, message: "Bugzilla API key is required" } satisfies TestResult,
      { status: 400 },
    );
  }

  try {
    // /rest/version is UNAUTHENTICATED on Bugzilla — using it as a key-
    // verification check would silently pass any key. /rest/bug?limit=1
    // requires a valid API key and 401s on a bad one, so we use that as
    // the real credential test. Versions still surfaced via the second
    // (cheap) /rest/version call below.
    await fetchJson(`${url}/rest/bug?limit=1&include_fields=id`, apiKey, body.bugzillaInsecure);

    // Now the cheap unauthenticated metadata calls — version + optional
    // whoami — for the success message. Failures here don't flip ok.
    let version: string | undefined;
    let whoami: string | undefined;
    try {
      const ver = await fetchJson(`${url}/rest/version`, apiKey, body.bugzillaInsecure);
      version = (ver as { version?: string }).version;
    } catch { /* version is informational only */ }
    try {
      const w = await fetchJson(`${url}/rest/whoami`, apiKey, body.bugzillaInsecure);
      whoami = (w as { name?: string }).name;
    } catch { /* whoami is optional — Bugzilla 5.0 doesn't ship it */ }

    const verPart = version ? `Bugzilla ${version}` : "Bugzilla";
    const whoPart = whoami ? `Connected as ${whoami} · ${verPart}` : `Connected · ${verPart}`;
    const trailer = whoami ? "" : " · whoami unsupported on this instance, the env-fallback login will be used";
    return NextResponse.json({
      ok: true,
      message: whoPart + trailer,
      version,
      whoami,
    } satisfies TestResult);
  } catch (err) {
    return NextResponse.json({
      ok: false,
      message: explainError(err),
    } satisfies TestResult);
  }
}

// ── HTTP helper (matches lib/bugzilla.ts's node:https approach) ──

function fetchJson(fullUrl: string, apiKey: string, insecure: boolean, timeoutMs = 15_000): Promise<unknown> {
  const u = new URL(fullUrl);
  u.searchParams.set("api_key", apiKey);
  const isHttps = u.protocol === "https:";
  const mod = isHttps ? https : http;

  return new Promise((resolve, reject) => {
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
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("response was not JSON"));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.end();
  });
}

function explainError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const msg = err.message;

  // Translate the most common errors into something a non-technical user
  // can act on — those are also the most common reasons "Test" fails.
  if (msg.includes("ENOTFOUND") || msg.includes("EAI_AGAIN")) {
    return "DNS lookup failed — check the URL or your network/VPN";
  }
  if (msg.includes("ECONNREFUSED")) {
    return "Connection refused — the Bugzilla server isn't reachable at that URL";
  }
  if (msg.includes("socket disconnected before secure TLS") || msg.includes("ENETUNREACH")) {
    return "Couldn't reach the Bugzilla server — check the URL and your VPN/network";
  }
  if (msg.includes("CERT_") || msg.includes("self-signed certificate") || msg.includes("self signed")) {
    return "TLS certificate rejected — turn on 'Skip TLS verification' if Bugzilla uses a self-signed cert";
  }
  if (msg.includes("HTTP 401") || msg.includes("HTTP 403")) {
    return "Authentication failed — check your API key";
  }
  if (msg.includes("HTTP 404")) {
    return "Bugzilla REST endpoint not found — verify the URL points at a Bugzilla instance (not a path inside one)";
  }
  if (msg.includes("timeout")) {
    return "Request timed out — VPN might be needed, or Bugzilla is overloaded";
  }
  // Bugzilla returns its credential errors as HTTP 400 with a JSON body
  // containing { code, message, error: true }. Pull the human message
  // out of the embedded JSON if we can — the raw response is unreadable.
  if (msg.startsWith("HTTP 400")) {
    const jsonStart = msg.indexOf("{");
    if (jsonStart !== -1) {
      try {
        const parsed = JSON.parse(msg.slice(jsonStart));
        if (parsed?.message) return `Bugzilla: ${parsed.message}`;
      } catch { /* fall through to raw msg below */ }
    }
  }
  return msg;
}
