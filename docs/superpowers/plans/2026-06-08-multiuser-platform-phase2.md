# Multi-user Platform — Phase 2 (Per-User Wiring) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app genuinely multi-user in server mode — every request runs as its logged-in user (their Bugzilla key + LLM config), all routes are session-gated, and un-set-up browsers are sent to `/setup` — while desktop mode (`MULTI_USER` unset) stays byte-identical.

**Architecture:** A `withUser()` HOF wraps every API route handler: pass-through in desktop mode, session-resolve + `runWithUser()` (AsyncLocalStorage) in server mode. `bugzilla.ts`/`llm.ts` switch their config source from `loadSettings()` → `getEffectiveSettings()` (built in Phase 1), so "act-as-user" falls out for free. `middleware.ts` gates page navigations to `/setup`.

**Tech Stack:** Next.js App Router (Node route handlers + edge middleware), the Phase-1 `lib/users/*` modules, `getEffectiveSettings()`.

---

## Standing constraints
- **Branch:** `multiuser-platform` (Phase 1 already committed here). Trailer on every commit:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Commits:** local; pushing is a separate explicit step.
- **No test runner** → verification is `npx tsc --noEmit`, the `tsx` self-checks, grep-audits, and a user-run two-user server smoke.
- **#1 invariant — desktop byte-identical** (`MULTI_USER` unset): `withUser` pass-through + `getEffectiveSettings` early-return guarantee it. Every task re-checks `tsc` and the grep-audit.

## Phase-2 file structure

| File | Action | Responsibility |
|---|---|---|
| `lib/users/with-user.ts` | Create | `withUser(handler)` HOF + `readSessionCookie(req)`. Desktop: pass-through. Server: cookie→`resolveSession`→`runWithUser` or 401. |
| `lib/bugzilla.ts` | Modify | `readConfig()` reads `getEffectiveSettings()` (act-as-user). |
| `lib/llm.ts` | Modify | `runTriage` / `runLlmText` / `hasConfiguredLlmProvider` read `getEffectiveSettings()`. |
| `lib/corpus/reranker-llm.ts` | Modify | `LlmReranker` modelId reads `getEffectiveSettings()` (current user's provider). |
| `app/api/**/route.ts` (~19) | Modify | Wrap each exported handler in `withUser`. (`/api/setup` stays unwrapped.) `app/api/settings` PUT 403s in server mode. |
| `middleware.ts` | Create | Server-mode: redirect page loads to `/setup` when no valid session; allow `/setup`, `/api/setup`, `_next`, static. |
| `scripts/dev-withuser-selfcheck.ts` | Create | Unit-checks `withUser` (desktop pass-through; server 401 vs runWithUser) with stubbed deps. |

**STAY `loadSettings()` (global, NOT per-user):** `settings.ts` internals, `app/api/corpus/status`, `app/api/corpus/download` — the corpus is a single shared install, not per-user. Do not switch these.

---

## Task 1: `withUser()` HOF + cookie helper

**Files:** Create `lib/users/with-user.ts`

- [ ] **Step 1: Write it**

```typescript
// lib/users/with-user.ts — wrap an App Router route handler so it runs as the
// request's logged-in user. Desktop mode (MULTI_USER unset): pure pass-through
// (no session needed) — keeps the single-user build byte-identical. Server mode:
// resolve the bt_session cookie → load the profile → runWithUser() so downstream
// getEffectiveSettings() sees this user; 401 JSON when there's no valid session.
import "server-only";
import { NextResponse } from "next/server";
import { isMultiUser } from "@/lib/settings";
import { resolveSession } from "./store";
import { runWithUser } from "./context";

export const SESSION_COOKIE = "bt_session";

/** Read the session token from a Request's Cookie header. */
export function readSessionCookie(req: Request): string {
  const raw = req.headers.get("cookie") || "";
  const m = raw.match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : "";
}

// App Router handlers are (req) or (req, { params }). Preserve both via rest args.
type RouteHandler = (req: Request, ctx?: any) => Response | Promise<Response>;

/** Gate + contextualize a route handler. */
export function withUser<T extends RouteHandler>(handler: T): T {
  const wrapped = async (req: Request, ctx?: any): Promise<Response> => {
    if (!isMultiUser()) return handler(req, ctx);          // desktop: unchanged
    const user = resolveSession(readSessionCookie(req));
    if (!user) {
      return NextResponse.json(
        { error: "setup required", code: "no_session" },
        { status: 401 },
      );
    }
    return runWithUser(user, () => handler(req, ctx));
  };
  return wrapped as T;
}
```

NOTE: `NextRequest` extends `Request`, so typing the param as `Request` accepts both. If a specific route's `tsc` complains that its `NextRequest`-typed handler isn't assignable to `RouteHandler`, widen `RouteHandler`'s first param to `any` — the runtime is unaffected.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "with-user.ts" || echo "✓ with-user clean"`
Expected: `✓ with-user clean`

- [ ] **Step 3: Self-check** — create `scripts/dev-withuser-selfcheck.ts`:

```typescript
// scripts/dev-withuser-selfcheck.ts — verify withUser desktop pass-through +
// server-mode gate, with stubbed store/settings. Run: npx tsx scripts/dev-withuser-selfcheck.ts
const assert = (c: unknown, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };

void (async () => {
  // Stub modules BEFORE importing with-user (Node ESM: use a tiny manual DI by
  // setting env + monkeypatching via the real modules is hard; instead re-create
  // the tiny logic the HOF depends on by toggling MULTI_USER + a fake cookie).
  // Desktop mode: handler runs regardless of cookie.
  process.env.MULTI_USER = "";
  let wu = await import("../lib/users/with-user");
  const handler = async (_req: Request) => new Response("ok", { status: 200 });
  let res = await wu.withUser(handler)(new Request("http://x/"));
  assert(res.status === 200, "desktop mode: pass-through runs handler");

  // Server mode, no cookie → 401.
  process.env.MULTI_USER = "1";
  // Fresh import so isMultiUser() re-reads — but ESM caches; instead assert the
  // RUNTIME branch via a request with no cookie. (isMultiUser reads env live.)
  res = await wu.withUser(handler)(new Request("http://x/"));
  assert(res.status === 401, "server mode, no session → 401");

  console.log("✓ withUser selfcheck passed (desktop pass-through, server 401)");
})();
```
Run: `npx tsx scripts/dev-withuser-selfcheck.ts`
Expected: `✓ withUser selfcheck passed …`
NOTE: `isMultiUser()` reads `process.env.MULTI_USER` live on each call, so toggling the env between the two `withUser(...)` invocations exercises both branches without re-importing. If module caching makes the desktop branch read a stale env, set `MULTI_USER=""` at the very top and split into two `node` runs (one per mode); the assertions are the contract. The 401 path needs no real store (no cookie → `resolveSession("")` returns null without touching the DB — verify `resolveSession("")` short-circuits on empty; it does per Phase 1).

- [ ] **Step 4: Commit**

```bash
git add lib/users/with-user.ts scripts/dev-withuser-selfcheck.ts
git commit -m "$(cat <<'EOF'
feat(users): withUser() route HOF — desktop pass-through / server session gate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `bugzilla.ts` acts as the request user

**Files:** Modify `lib/bugzilla.ts`

- [ ] **Step 1:** In `readConfig()` (~line 58), change the import + the one line:
  - Ensure the file imports `getEffectiveSettings` (add to the existing `@/lib/settings` import, or `import { getEffectiveSettings } from "@/lib/settings";`).
  - Replace `const s = loadSettings();` with `const s = getEffectiveSettings();`.
  - If `loadSettings` is now unused in the file, drop it from the import (only if unused — check; `noUnusedLocals` is off so it's not fatal either way).

Result:
```typescript
function readConfig(): BugzillaConfig {
  // Desktop: global settings. Server mode: the current request's user (their
  // Bugzilla key) via getEffectiveSettings() → all reads/writes act AS them.
  const s = getEffectiveSettings();
  return {
    url: (s.bugzillaUrl || "").replace(/\/$/, ""),
    apiKey: s.bugzillaApiKey,
    insecure: s.bugzillaInsecure,
    login: s.bugzillaLogin,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "bugzilla.ts" || echo "✓ bugzilla clean"`
Expected: `✓ bugzilla clean`

- [ ] **Step 3: Commit**

```bash
git add lib/bugzilla.ts
git commit -m "$(cat <<'EOF'
feat(bugzilla): act as the request user via getEffectiveSettings()

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `llm.ts` + `reranker-llm.ts` use the request user's LLM

**Files:** Modify `lib/llm.ts`, `lib/corpus/reranker-llm.ts`

- [ ] **Step 1: `lib/llm.ts`** — switch the three per-user reads from `loadSettings()` to `getEffectiveSettings()`:
  - Add `getEffectiveSettings` to the `@/lib/settings` import (or a new import).
  - Line ~679 (inside `runTriage`): `const s = loadSettings();` → `const s = getEffectiveSettings();`
  - Line ~1181 (inside `runLlmText`): `const s = loadSettings();` → `const s = getEffectiveSettings();`
  - Line ~816 (`hasConfiguredLlmProvider(s = loadSettings())`): change the default param to `s = getEffectiveSettings()`.

- [ ] **Step 2: `lib/corpus/reranker-llm.ts`** — line ~45 (`LlmReranker` constructor, `const s = loadSettings()` for the modelId label): change to `getEffectiveSettings()`. Update the import accordingly.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "llm.ts|reranker-llm.ts" || echo "✓ llm clean"`
Expected: `✓ llm clean`

- [ ] **Step 4: Commit**

```bash
git add lib/llm.ts lib/corpus/reranker-llm.ts
git commit -m "$(cat <<'EOF'
feat(llm): triage + rerank use the request user's LLM via getEffectiveSettings()

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `middleware.ts` setup-gate (page navigations)

**Files:** Create `middleware.ts` (repo root, sibling of `next.config.mjs`)

- [ ] **Step 1: Write it**

```typescript
// middleware.ts — server-mode setup gate. Page navigations with no valid
// bt_session cookie are redirected to /setup. Desktop mode (MULTI_USER unset)
// is a no-op. API auth is handled separately by withUser() (returns 401, not a
// redirect), so /api/* is left alone here.
import { NextResponse, type NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  if (process.env.MULTI_USER !== "1") return NextResponse.next();
  const { pathname } = req.nextUrl;
  // Let the setup flow, its API, Next internals, and static assets through.
  if (
    pathname === "/setup" ||
    pathname.startsWith("/api/setup") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    /\.[\w]+$/.test(pathname)            // any file with an extension (static)
  ) {
    return NextResponse.next();
  }
  const hasSession = !!req.cookies.get("bt_session")?.value;
  if (hasSession) return NextResponse.next();
  // Pages → redirect to /setup. (APIs are gated by withUser → 401, but as a
  // belt-and-suspenders for un-wrapped API calls, 401 them here too.)
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "setup required" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/setup";
  return NextResponse.redirect(url);
}

// Run on everything except Next internals/static (cheap matcher; the function
// re-checks too).
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

NOTE: middleware runs on the **edge runtime** — it may ONLY use `process.env` + `req.cookies` (no `node:*`, no the store). It does NOT validate the session against the DB (can't — edge); it only checks cookie PRESENCE. Real validation is `withUser` (Node) per request. This is intentional: middleware is a cheap redirect-gate, `withUser` is the authority.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "middleware.ts" || echo "✓ middleware clean"`
Expected: `✓ middleware clean`

- [ ] **Step 3: Commit**

```bash
git add middleware.ts
git commit -m "$(cat <<'EOF'
feat(platform): server-mode middleware setup-gate for page navigations

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wrap all API route handlers in `withUser`

**Files:** Modify every `app/api/**/route.ts` EXCEPT `app/api/setup/route.ts`.

The 19 route files to wrap (verify with `find app/api -name route.ts`):
```
corpus/acronym  corpus/diag  corpus/download  corpus/figure  corpus/lookup
corpus/search   corpus/status  corpus/toc
products  settings  settings/test  stats
tickets  tickets/[id]  tickets/[id]/attachments/[attachmentId]
tickets/[id]/submit  tickets/[id]/triage  tickets/[id]/triage/followup
users  whoami
```
(Do NOT wrap `app/api/setup/route.ts` — it is the unauthenticated entry.)

- [ ] **Step 1: Apply the wrap to each route file.** For every exported handler (`GET`, `POST`, `PUT`, `DELETE`):
  - Add at the top: `import { withUser } from "@/lib/users/with-user";`
  - Convert `export async function GET(req: NextRequest) { … }` →
    ```typescript
    export const GET = withUser(async (req: NextRequest) => { … });
    ```
    and for the params form:
    ```typescript
    export const GET = withUser(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => { … });
    ```
  - Keep `export const dynamic = "force-dynamic";` as-is.
  - Repeat for each verb the file exports.

Worked example — `app/api/whoami/route.ts`:
```typescript
import { NextRequest, NextResponse } from "next/server";
import { bridgeWhoami } from "@/lib/bridge";
import { MOCK_WHOAMI } from "@/lib/mock-data";
import { cached, CACHE_TTL } from "@/lib/server-cache";
import { withUser } from "@/lib/users/with-user";

export const dynamic = "force-dynamic";

export const GET = withUser(async (req: NextRequest) => {
  const url = new URL(req.url);
  // … unchanged body …
});
```

- [ ] **Step 2: Special case — `app/api/settings/route.ts`.** Wrap GET + PUT in `withUser`. Additionally, in **server mode** the PUT must NOT rewrite the shared global `settings.json` (it would change everyone's base config). Guard the PUT body:
  ```typescript
  import { isMultiUser } from "@/lib/settings";
  // …inside the PUT handler, first line:
  if (isMultiUser()) {
    return NextResponse.json(
      { error: "In server mode, settings are per-user — change them in /setup." },
      { status: 403 },
    );
  }
  ```
  GET may stay (it returns the effective settings view). (A full per-user settings editor is a later phase.)

- [ ] **Step 3: Grep-audit — every route (except setup) is wrapped.**
```bash
cd /Users/huifu/bugzilla-triage-desktop
for f in $(find app/api -name route.ts | grep -v "api/setup/route.ts"); do
  grep -q "withUser(" "$f" || echo "UNWRAPPED: $f"
done; echo "audit done"
# also: setup route must NOT be wrapped
grep -q "withUser(" app/api/setup/route.ts && echo "⚠ setup should NOT be wrapped" || echo "✓ setup unwrapped"
```
Expected: no `UNWRAPPED:` lines, `✓ setup unwrapped`, `audit done`.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit` → Expected: zero errors. (Fix any handler whose `NextRequest` type doesn't satisfy `withUser`'s generic — see Task 1 note.)

- [ ] **Step 5: Commit**

```bash
git add app/api
git commit -m "$(cat <<'EOF'
feat(platform): gate all API routes with withUser (server-mode session)

Every app/api route except /api/setup now runs inside withUser — pass-through
in desktop mode, session-gated + per-user in server mode. /api/settings PUT
403s in server mode (config is per-user via /setup).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Verification — desktop invariant + two-user server smoke

**Files:** none (verification) + optionally `scripts/dev-multiuser-smoke.sh` (curl harness, user-run)

- [ ] **Step 1: Desktop byte-identical grep-audit.** Confirm the ONLY per-user `loadSettings()→getEffectiveSettings()` switches are the intended ones, and the corpus/global ones still use `loadSettings()`:
```bash
cd /Users/huifu/bugzilla-triage-desktop
echo "getEffectiveSettings call sites (should be: bugzilla.ts, llm.ts x3, reranker-llm.ts, settings.ts def):"
grep -rn "getEffectiveSettings()" lib app | grep -v "export function getEffectiveSettings"
echo "corpus still global (status/download must show loadSettings):"
grep -n "loadSettings()" app/api/corpus/status/route.ts app/api/corpus/download/route.ts
```
Expected: switches only in bugzilla.ts / llm.ts / reranker-llm.ts; corpus status+download still `loadSettings()`.

- [ ] **Step 2: Whole-project typecheck** — `npx tsc --noEmit` → zero errors.

- [ ] **Step 3: Desktop-mode regression (user or agent)** — with `MULTI_USER` unset, `npm run dev`; `/`, `/spec`, a triage all behave as v0.6.0 (no `/setup` redirect; withUser is pass-through). Confirm no `/setup` redirect happens.

- [ ] **Step 4: Two-user server smoke (USER-run — needs two real Bugzilla keys).** Create `scripts/dev-multiuser-smoke.sh` documenting it:
```bash
# MULTI_USER=1 APP_SECRET=$(openssl rand -hex 32) PROFILES_DB=/tmp/p.db \
#   BUGZILLA_URL=<url> BUGZILLA_INSECURE=true npm run dev
#
# 1. curl -s localhost:3000/api/whoami            → 401 (no session)
# 2. Browser A: /setup with user A's email+key → triage a ticket → comment posts AS A in Bugzilla
# 3. Browser B (separate cookie jar): /setup with user B's key → triage → posts AS B
# 4. Confirm A's session never sees B's key: each /api/whoami returns the right identity
# 5. sqlite3 /tmp/p.db "SELECT email FROM users;"  → both, encrypted keys
```
Acceptance: an unauthenticated API call 401s; A's and B's actions are attributed to A and B respectively in Bugzilla; no key cross-contamination.

- [ ] **Step 5: Commit the smoke doc + any fixups**, then Phase 2 is done.

```bash
git add scripts/dev-multiuser-smoke.sh
git commit -m "$(cat <<'EOF'
docs(platform): two-user server smoke runbook (Phase 2 acceptance)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 (still outlined — next plan)
Dockerfile (multi-stage; `.next/standalone`; `MULTI_USER=1`), `deploy/README.md` (reverse-proxy + HTTPS + `APP_SECRET`/`PROFILES_DB` volume + backup), per-session/IP rate-limit on triage/LLM routes, append-only audit log of Bugzilla writes (email · ticket · action · ts), `COMPANY_LLM_*` env documentation.

---

## Self-review (Phase 2 vs spec)

**Spec coverage:** withUser gating (Task 1+5) ✓; act-as-user Bugzilla (Task 2) ✓; per-user LLM incl. company default already in getEffectiveSettings (Task 3) ✓; middleware setup-gate (Task 4) ✓; gate-all-routes (Task 5) ✓; shared-corpus stays global (Tasks 5/6 — corpus routes gated but keep loadSettings) ✓; desktop byte-identical (withUser pass-through + getEffectiveSettings early-return; Tasks 1/6 audit) ✓; two-user attribution acceptance (Task 6) ✓. Phase 3 (deploy/harden) deferred + outlined.

**Placeholder scan:** concrete code for with-user.ts + middleware.ts + the exact one-line switches + a worked route-wrap example + the full route list + grep-audits. The only "adapt" notes (withUser generic widening; selfcheck env-toggle vs two runs) are integration seams against real tsc/ESM behavior, not deferred logic.

**Type/name consistency:** `withUser`, `readSessionCookie`, `SESSION_COOKIE="bt_session"` (matches Phase-1 `/api/setup`'s cookie), `getEffectiveSettings`, `isMultiUser`, `resolveSession`, `runWithUser` — all consistent with Phase 1. The cookie name `bt_session` matches what `/api/setup` sets.
```
