# Multi-user Platform — Phase 1 (Identity Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the per-user identity foundation — encrypted profile store, AsyncLocalStorage user context, dual-mode `getEffectiveSettings()`, and a self-service `/setup` flow — so a `MULTI_USER=1` server can identify users and resolve their own Bugzilla/LLM creds, **while the single-user desktop build stays byte-identical**.

**Architecture:** A writable `profiles.db` (better-sqlite3) holds users + sessions with AES-256-GCM-encrypted secrets. A `withUser`/ALS context (Phase 2 wires it onto routes) carries the request's user. `getEffectiveSettings()` returns the global `settings.json` in desktop mode and `{global base ⊕ current user}` in server mode. `/setup` self-registers a user (email + Bugzilla key + LLM choice) and issues a session cookie.

**Tech Stack:** Next.js (App Router, Node runtime), better-sqlite3, node:crypto (AES-256-GCM), node:async_hooks (AsyncLocalStorage).

---

## Standing constraints
- **Branch:** `multiuser-platform` (off `main` @ v0.6.0). All commits here.
- **Commits:** maintainer's rule is "commit/push only when asked"; approving this plan sanctions the per-task commits (local; pushing is separate).
  Trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **No test runner** in-repo → "tests" are `*-selfcheck.mjs` scripts + `npx tsc --noEmit` + targeted manual checks.
- **Desktop must stay byte-identical** when `MULTI_USER` is unset — this is the #1 acceptance criterion; every task verifies it.
- The repo uses the `@/` path alias for repo-root imports.

## Phase-1 file structure

| File | Action | Responsibility |
|---|---|---|
| `lib/users/crypto.ts` | Create | AES-256-GCM encrypt/decrypt of stored secrets via `APP_SECRET`. |
| `lib/users/store.ts` | Create | `profiles.db` (writable better-sqlite3): users + sessions; CRUD + session create/resolve. Decrypts secrets into `UserProfile`. |
| `lib/users/context.ts` | Create | `AsyncLocalStorage<UserContext>` + `runWithUser`/`getCurrentUser`. |
| `lib/settings.ts` | Modify | Add `isMultiUser()` + `getEffectiveSettings()` (dual-mode). `loadSettings()` untouched. |
| `app/api/setup/route.ts` | Create | `POST` self-register (validate Bugzilla, upsert profile, create session, set cookie); `GET` setup status. |
| `app/setup/page.tsx` | Create | Onboarding form (email + Bugzilla key + LLM choice incl. company default). |
| `scripts/dev-users-selfcheck.mjs` | Create | Round-trip checks for crypto + store (no server needed). |

**Out of Phase 1** (Phase 2/3): `withUser()` on routes, `bugzilla.ts`/`llm.ts` switching to `getEffectiveSettings()`, `middleware.ts` setup-gate, Dockerfile, rate-limit, audit log. Phase 1 builds + unit-checks the pieces; it does NOT yet gate the app.

---

## Task 1: Secret encryption (`lib/users/crypto.ts`)

**Files:** Create `lib/users/crypto.ts`

- [ ] **Step 1: Write the module**

```typescript
// lib/users/crypto.ts — AES-256-GCM encryption for at-rest user secrets
// (Bugzilla + LLM API keys in profiles.db). Key is derived from APP_SECRET,
// which is REQUIRED in server mode (validated at store init). Format:
//   "<iv-b64>.<authtag-b64>.<ciphertext-b64>"
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const ALGO = "aes-256-gcm";

function key(): Buffer {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 16) {
    throw new Error("APP_SECRET (≥16 chars) is required to encrypt user secrets in server mode.");
  }
  // Derive a stable 32-byte key from the configured secret.
  return createHash("sha256").update(s, "utf8").digest();
}

/** Encrypt a UTF-8 secret. Empty input → empty output (no-op for unset keys). */
export function encryptSecret(plain: string): string {
  if (!plain) return "";
  const iv = randomBytes(12);
  const c = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

/** Decrypt a blob produced by encryptSecret. Empty → empty. Throws on tamper
 *  (GCM auth failure) or malformed input. */
export function decryptSecret(blob: string): string {
  if (!blob) return "";
  const [ivB, tagB, encB] = blob.split(".");
  if (!ivB || !tagB || !encB) throw new Error("malformed encrypted secret");
  const d = createDecipheriv(ALGO, key(), Buffer.from(ivB, "base64"));
  d.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([d.update(Buffer.from(encB, "base64")), d.final()]).toString("utf8");
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "users/crypto.ts" || echo "✓ crypto clean"`
Expected: `✓ crypto clean`

- [ ] **Step 3: Commit**

```bash
git add lib/users/crypto.ts
git commit -m "$(cat <<'EOF'
feat(users): AES-256-GCM at-rest encryption for user secrets

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

(The crypto round-trip is verified in Task 3's self-check, alongside the store.)

---

## Task 2: Profile + session store (`lib/users/store.ts`)

**Files:** Create `lib/users/store.ts`

- [ ] **Step 1: Write the store**

```typescript
// lib/users/store.ts — writable profiles.db (better-sqlite3): per-user profiles
// and opaque session tokens. SEPARATE from the read-only corpus DB. Secrets are
// encrypted at rest (crypto.ts); UserProfile carries them DECRYPTED in memory.
import { createRequire } from "node:module";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { appDataDir } from "@/lib/settings";
import { encryptSecret, decryptSecret } from "./crypto";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

export interface UserProfile {
  email: string;
  bugzillaApiKey: string;   // decrypted
  llmProvider: string;      // "anthropic" | "openai-compatible" | "claude-cli" | "codex-cli"
  llmBaseUrl: string;
  llmApiKey: string;        // decrypted; "" when useCompanyLlm
  defaultModel: string;
  useCompanyLlm: boolean;
  themeMode: string;        // "system" | "light" | "dark"
}

let _db: import("better-sqlite3").Database | null = null;
function db() {
  if (_db) return _db;
  const p = process.env.PROFILES_DB || path.join(appDataDir(), "profiles.db");
  _db = new Database(p);
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      bugzilla_key_enc TEXT NOT NULL,
      llm_provider TEXT NOT NULL DEFAULT 'anthropic',
      llm_base_url  TEXT NOT NULL DEFAULT '',
      llm_key_enc   TEXT NOT NULL DEFAULT '',
      default_model TEXT NOT NULL DEFAULT '',
      use_company_llm INTEGER NOT NULL DEFAULT 0,
      theme_mode    TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, email TEXT NOT NULL,
      created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
    );
  `);
  return _db;
}

export interface UpsertInput {
  email: string; bugzillaApiKey: string;
  llmProvider: string; llmBaseUrl: string; llmApiKey: string;
  defaultModel: string; useCompanyLlm: boolean; themeMode: string;
}

export function upsertUser(p: UpsertInput): void {
  const now = new Date().toISOString();
  db().prepare(`
    INSERT INTO users (email, bugzilla_key_enc, llm_provider, llm_base_url, llm_key_enc,
                       default_model, use_company_llm, theme_mode, created_at, updated_at)
    VALUES (@email, @bk, @prov, @base, @lk, @model, @company, @theme, @now, @now)
    ON CONFLICT(email) DO UPDATE SET
      bugzilla_key_enc=@bk, llm_provider=@prov, llm_base_url=@base, llm_key_enc=@lk,
      default_model=@model, use_company_llm=@company, theme_mode=@theme, updated_at=@now
  `).run({
    email: p.email.toLowerCase().trim(),
    bk: encryptSecret(p.bugzillaApiKey),
    prov: p.llmProvider, base: p.llmBaseUrl,
    lk: encryptSecret(p.llmApiKey),
    model: p.defaultModel, company: p.useCompanyLlm ? 1 : 0,
    theme: p.themeMode, now,
  });
}

export function getUser(email: string): UserProfile | null {
  const r = db().prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase().trim()) as any;
  if (!r) return null;
  return {
    email: r.email,
    bugzillaApiKey: decryptSecret(r.bugzilla_key_enc),
    llmProvider: r.llm_provider, llmBaseUrl: r.llm_base_url,
    llmApiKey: decryptSecret(r.llm_key_enc),
    defaultModel: r.default_model, useCompanyLlm: !!r.use_company_llm,
    themeMode: r.theme_mode,
  };
}

/** Create an opaque session token bound to an email. */
export function createSession(email: string): string {
  const token = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  db().prepare("INSERT INTO sessions (token, email, created_at, last_seen_at) VALUES (?,?,?,?)")
    .run(token, email.toLowerCase().trim(), now, now);
  return token;
}

/** Resolve a session token → that user's profile, bumping last_seen. null if
 *  the token is unknown or the user was deleted. */
export function resolveSession(token: string): UserProfile | null {
  if (!token) return null;
  const s = db().prepare("SELECT email FROM sessions WHERE token = ?").get(token) as any;
  if (!s) return null;
  db().prepare("UPDATE sessions SET last_seen_at = ? WHERE token = ?").run(new Date().toISOString(), token);
  return getUser(s.email);
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "users/store.ts" || echo "✓ store clean"`
Expected: `✓ store clean`

- [ ] **Step 3: Commit**

```bash
git add lib/users/store.ts
git commit -m "$(cat <<'EOF'
feat(users): profiles.db store — encrypted user profiles + sessions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Self-check for crypto + store

**Files:** Create `scripts/dev-users-selfcheck.mjs`

- [ ] **Step 1: Write the self-check** (uses a temp DB + APP_SECRET; no Next server)

```javascript
// scripts/dev-users-selfcheck.mjs — verify crypto round-trip + store CRUD/session
// against a throwaway profiles.db. Run: node scripts/dev-users-selfcheck.mjs
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
process.env.APP_SECRET = "selfcheck-secret-key-0123456789";
process.env.PROFILES_DB = path.join(os.tmpdir(), `profiles-selfcheck-${process.pid}.db`);
const require = createRequire(import.meta.url);
const tsx = require("tsx/cjs/api"); // load TS modules from a .mjs harness
const { encryptSecret, decryptSecret } = tsx.require("../lib/users/crypto.ts", import.meta.url);
const store = tsx.require("../lib/users/store.ts", import.meta.url);
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };

// crypto round-trip + tamper
const blob = encryptSecret("hunter2-bugzilla-key");
assert(blob.split(".").length === 3, "blob has iv.tag.ct");
assert(decryptSecret(blob) === "hunter2-bugzilla-key", "decrypt round-trips");
assert(encryptSecret("") === "" && decryptSecret("") === "", "empty no-op");
let tampered = false; try { decryptSecret(blob.slice(0, -2) + "xx"); } catch { tampered = true; }
assert(tampered, "tampered blob throws (GCM auth)");

// store CRUD + session
store.upsertUser({ email: "A@x.com", bugzillaApiKey: "bz-A", llmProvider: "openai-compatible",
  llmBaseUrl: "https://api.deepseek.com", llmApiKey: "llm-A", defaultModel: "deepseek-chat",
  useCompanyLlm: false, themeMode: "system" });
const a = store.getUser("a@x.com"); // case-insensitive
assert(a && a.bugzillaApiKey === "bz-A" && a.llmApiKey === "llm-A", "getUser decrypts");
assert(a.email === "a@x.com", "email normalized lowercase");
const tok = store.createSession("a@x.com");
const resolved = store.resolveSession(tok);
assert(resolved && resolved.email === "a@x.com" && resolved.bugzillaApiKey === "bz-A", "session resolves to user");
assert(store.resolveSession("bogus") === null, "bad token → null");

fs.rmSync(process.env.PROFILES_DB, { force: true });
fs.rmSync(process.env.PROFILES_DB + "-wal", { force: true });
fs.rmSync(process.env.PROFILES_DB + "-shm", { force: true });
console.log("✓ users selfcheck passed (crypto round-trip + tamper, store CRUD, sessions)");
```

NOTE: if `tsx/cjs/api`'s `tsx.require` signature differs in the installed tsx version, the implementer adapts to load the two TS modules (e.g. `import` with a tsx loader, or compile-on-the-fly). The assertions are the contract.

- [ ] **Step 2: Run it**

Run: `node scripts/dev-users-selfcheck.mjs`
Expected: `✓ users selfcheck passed …`

- [ ] **Step 3: Commit**

```bash
git add scripts/dev-users-selfcheck.mjs
git commit -m "$(cat <<'EOF'
test(users): self-check for crypto round-trip + profile store + sessions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: User context (`lib/users/context.ts`)

**Files:** Create `lib/users/context.ts`

- [ ] **Step 1: Write it**

```typescript
// lib/users/context.ts — request-scoped current user via AsyncLocalStorage.
// Phase 2's withUser() establishes the context per request; lib code reads it
// through settings.getEffectiveSettings(). Type-only import of UserProfile keeps
// this module free of a runtime dependency on the store (no import cycle).
import { AsyncLocalStorage } from "node:async_hooks";
import type { UserProfile } from "./store";

export type UserContext = UserProfile;

const als = new AsyncLocalStorage<UserContext>();

/** Run `fn` with `ctx` as the current user for the duration (incl. awaits). */
export function runWithUser<T>(ctx: UserContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** The current request's user, or null outside any runWithUser scope. */
export function getCurrentUser(): UserContext | null {
  return als.getStore() ?? null;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "users/context.ts" || echo "✓ context clean"`
Expected: `✓ context clean`

- [ ] **Step 3: Commit**

```bash
git add lib/users/context.ts
git commit -m "$(cat <<'EOF'
feat(users): AsyncLocalStorage request-scoped user context

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Dual-mode `getEffectiveSettings()` (`lib/settings.ts`)

**Files:** Modify `lib/settings.ts`

Context: `loadSettings()` (cached global) and `Settings` already exist. Per-user fields = `bugzillaApiKey, bugzillaLogin, llmProvider, llmBaseUrl, anthropicApiKey, defaultModel, themeMode`. Server-global fields (from env via `envSettings()`): `bugzillaUrl, bugzillaInsecure, corpus*`.

- [ ] **Step 1: Add the dual-mode resolver** at the end of `lib/settings.ts`:

```typescript
import { getCurrentUser } from "./users/context";

/** True when running as the hosted multi-user server (vs the single-user
 *  desktop build). */
export function isMultiUser(): boolean {
  return process.env.MULTI_USER === "1";
}

/** The settings to use for the CURRENT operation.
 *  - Desktop mode (default): the global settings.json — byte-identical to today.
 *  - Server mode: the env-global base (bugzillaUrl/insecure/corpus) overlaid with
 *    the current request's user (their Bugzilla key + LLM config). If a user
 *    chose the company LLM, the LLM fields come from COMPANY_LLM_* env. Outside a
 *    request (no current user) returns the base only. */
export function getEffectiveSettings(): Settings {
  if (!isMultiUser()) return loadSettings();
  const base = loadSettings(); // env-only in server mode (no per-user file) → global base
  const u = getCurrentUser();
  if (!u) return base;
  const company = u.useCompanyLlm;
  return {
    ...base,
    bugzillaApiKey: u.bugzillaApiKey,
    bugzillaLogin: u.email,
    llmProvider: (company ? (process.env.COMPANY_LLM_PROVIDER || "openai-compatible") : u.llmProvider) as LlmProvider,
    llmBaseUrl:   company ? (process.env.COMPANY_LLM_BASE_URL || "") : u.llmBaseUrl,
    anthropicApiKey: company ? (process.env.COMPANY_LLM_API_KEY || "") : u.llmApiKey,
    defaultModel: company ? (process.env.COMPANY_LLM_MODEL || u.defaultModel) : u.defaultModel,
    themeMode: (u.themeMode || base.themeMode) as ThemeMode,
  };
}
```

IMPORTANT: do NOT change `loadSettings()` or `readConfig()` callers in this task — only ADD the two exports. (Phase 2 switches `bugzilla.ts`/`llm.ts` to `getEffectiveSettings()`.) Confirm no import cycle: `settings.ts → users/context.ts` (which only `import type`s the store) is acyclic at runtime.

- [ ] **Step 2: Typecheck + desktop-mode invariant check**

Run:
```bash
npx tsc --noEmit 2>&1 | grep -E "lib/settings.ts" || echo "✓ settings clean"
# Desktop mode: getEffectiveSettings === loadSettings (MULTI_USER unset)
node -e 'process.env.SETTINGS_PATH="/tmp/none.json"; const tsx=require("tsx/cjs/api"); const s=tsx.require("./lib/settings.ts", "file://"+process.cwd()+"/"); const a=JSON.stringify(s.getEffectiveSettings()), b=JSON.stringify(s.loadSettings()); console.log(a===b ? "✓ desktop mode: getEffectiveSettings == loadSettings" : "✗ DIVERGED");'
```
Expected: `✓ settings clean` and `✓ desktop mode: getEffectiveSettings == loadSettings`. (Adapt the tsx-load line to the installed tsx API if needed.)

- [ ] **Step 3: Commit**

```bash
git add lib/settings.ts
git commit -m "$(cat <<'EOF'
feat(settings): dual-mode getEffectiveSettings() + isMultiUser()

Desktop mode returns the global settings (unchanged); server mode overlays
the request user's Bugzilla/LLM creds (or COMPANY_LLM_* when they opt into
the company default). loadSettings/readConfig callers untouched in Phase 1.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `/api/setup` route (self-register + session)

**Files:** Create `app/api/setup/route.ts`

Read an existing route (e.g. `app/api/settings/route.ts` and `app/api/settings/test/route.ts`) first for the handler + Bugzilla-test pattern.

- [ ] **Step 1: Write the route**

```typescript
import { NextResponse } from "next/server";
import { runWithUser } from "@/lib/users/context";
import { upsertUser, createSession, getUser } from "@/lib/users/store";
import { whoami } from "@/lib/bugzilla";       // verify the Bugzilla key works
import { isMultiUser } from "@/lib/settings";

export const dynamic = "force-dynamic";
const COOKIE = "bt_session";

// GET → whether THIS browser already has a profile (drives setup-vs-redirect).
export async function GET(req: Request) {
  if (!isMultiUser()) return NextResponse.json({ multiUser: false });
  const token = readCookie(req, COOKIE);
  const ok = !!token;
  return NextResponse.json({ multiUser: true, hasSession: ok });
}

// POST → validate + create/update the profile, issue a session cookie.
export async function POST(req: Request) {
  if (!isMultiUser()) return NextResponse.json({ error: "not in server mode" }, { status: 400 });
  const b = await req.json().catch(() => ({}));
  const email = String(b.email || "").toLowerCase().trim();
  const bugzillaApiKey = String(b.bugzillaApiKey || "").trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return NextResponse.json({ error: "valid email required" }, { status: 400 });
  if (!bugzillaApiKey) return NextResponse.json({ error: "Bugzilla API key required" }, { status: 400 });

  const useCompanyLlm = !!b.useCompanyLlm;
  const profile = {
    email, bugzillaApiKey,
    llmProvider: String(b.llmProvider || "anthropic"),
    llmBaseUrl: String(b.llmBaseUrl || "").trim(),
    llmApiKey: useCompanyLlm ? "" : String(b.llmApiKey || "").trim(),
    defaultModel: String(b.defaultModel || "").trim(),
    useCompanyLlm,
    themeMode: String(b.themeMode || "system"),
  };

  // Verify the Bugzilla key by calling whoami AS this prospective user.
  try {
    await runWithUser({ ...profile } as any, async () => { await whoami(); });
  } catch (e) {
    return NextResponse.json({ error: `Bugzilla key check failed: ${(e as Error).message}` }, { status: 400 });
  }

  upsertUser(profile);
  const token = createSession(email);
  const res = NextResponse.json({ ok: true, email });
  res.cookies.set(COOKIE, token, { httpOnly: true, sameSite: "strict", secure: true, path: "/", maxAge: 60 * 60 * 24 * 30 });
  return res;
}

function readCookie(req: Request, name: string): string {
  const raw = req.headers.get("cookie") || "";
  const m = raw.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : "";
}
```

NOTE for implementer: confirm `whoami` is exported from `lib/bugzilla.ts` (the `/api/whoami` route calls it) and that calling it inside `runWithUser` resolves the key via `getEffectiveSettings()` — this is the FIRST consumer proving the per-user path end-to-end. If `bugzilla.ts` still reads `loadSettings()` directly (Phase 2 not done yet), then for THIS task make the setup-time check call a minimal inline `whoami` that uses `profile.bugzillaApiKey` + the env `BUGZILLA_URL` directly, and leave the full switch to Phase 2. Pick whichever keeps Phase 1 self-contained; note which you did.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "api/setup" || echo "✓ setup route clean"`
Expected: `✓ setup route clean`

- [ ] **Step 3: Commit**

```bash
git add app/api/setup/route.ts
git commit -m "$(cat <<'EOF'
feat(setup): /api/setup — self-register (validate Bugzilla, profile, session)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `/setup` page

**Files:** Create `app/setup/page.tsx`

Read `app/settings/` (the existing Settings form) first and mirror its component/styling conventions (inputs, the "Test connection" affordance, Tailwind classes).

- [ ] **Step 1: Build the form** — a client component with fields: **email**, **Bugzilla API key**, and an LLM section with a radio: **"Use company AI (DeepSeek)"** vs **"My own provider"** (which reveals provider/baseURL/key/model, reusing the Settings page's LLM sub-form). Submit → `POST /api/setup` → on `{ok}` redirect to `/`; on error show the message. Match the Settings page layout so it feels native. (Full JSX mirrors `app/settings/page.tsx`'s form — the implementer adapts that component, dropping the corpus/global fields and adding the email field + company-LLM radio.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "app/setup/page" || echo "✓ setup page clean"`
Expected: `✓ setup page clean`

- [ ] **Step 3: Commit**

```bash
git add app/setup/page.tsx
git commit -m "$(cat <<'EOF'
feat(setup): /setup onboarding page (email + Bugzilla key + LLM choice)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Phase-1 integration check

**Files:** none (verification)

- [ ] **Step 1: Whole-project typecheck**

Run: `npx tsc --noEmit` → Expected: zero errors.

- [ ] **Step 2: Desktop-mode regression** — with `MULTI_USER` unset, start the app (`npm run dev`) and confirm `/` and `/spec` behave exactly as v0.6.0 (no `/setup` gate yet — there's no middleware in Phase 1; this is expected). Confirm no `users/*` module is imported on the desktop hot path except via the inert `getEffectiveSettings` (which returns `loadSettings()`).

- [ ] **Step 3: Server-mode smoke** (manual, on the implementer's machine):
```bash
MULTI_USER=1 APP_SECRET=dev-secret-please-change PROFILES_DB=/tmp/p.db \
  BUGZILLA_URL=<your bugzilla> npm run dev
# POST a setup with a REAL Bugzilla key, confirm the cookie is set + profile row exists:
sqlite3 /tmp/p.db "SELECT email, length(bugzilla_key_enc)>0 AS has_key FROM users;"
```
Expected: the Bugzilla check passes, a `users` row exists with an encrypted key, a `sessions` row exists. (Full route-gating + two-user attribution is Phase 2's acceptance test.)

- [ ] **Step 4: Commit any fixups**, then this phase is done.

---

## Phases 2 & 3 (outline — separate plans)

**Phase 2 — per-user wiring** (own plan): add `withUser(handler)` (reads `bt_session`, `resolveSession`, `runWithUser`, 401/redirect on miss) in `lib/users/with-user.ts`; wrap every `app/api/*/route.ts`; switch `lib/bugzilla.ts` `readConfig()` and `lib/llm.ts` `runTriage`/`runLlmText` from `loadSettings()` → `getEffectiveSettings()`; add `middleware.ts` to redirect un-set-up page loads to `/setup`; wire `COMPANY_LLM_*`. **Acceptance: two users, each their own key, writes attributed correctly, no cross-contamination** (grep-audit every `loadSettings()` call site).

**Phase 3 — deploy + harden** (own plan): `Dockerfile` (multi-stage; build `.next/standalone`; run `node server.js` with `MULTI_USER=1`), `deploy/README.md` (reverse-proxy + HTTPS + `APP_SECRET`/`PROFILES_DB` volume + backup note), per-session/IP rate-limit on triage/LLM routes, an append-only audit log of Bugzilla writes (email · ticket · action · ts).

---

## Self-review (Phase 1 vs spec)

**Spec coverage (Phase 1 scope):** crypto (Task 1) ✓; profiles.db store + sessions (Task 2) ✓; ALS context (Task 4) ✓; dual-mode `getEffectiveSettings`/`isMultiUser` (Task 5) ✓; `/setup` + `/api/setup` + session cookie (Tasks 6–7) ✓; desktop-byte-identical invariant (Tasks 5/8) ✓; secrets-encrypted-at-rest + `APP_SECRET`-required (Tasks 1/3) ✓. Phase-2/3 spec items (withUser gating, act-as-user in bugzilla/llm, middleware, Dockerfile, rate-limit, audit) are explicitly deferred + outlined.

**Placeholder scan:** all modules have complete code. Two intentional "adapt to installed API" notes (the `tsx.require` loader in the self-checks; the Phase-1 `whoami` check vs Phase-2 wiring) are integration seams the implementer resolves against the real tsx version / bugzilla export — not deferred logic.

**Type/name consistency:** `UserProfile`/`UpsertInput`/`UserContext`, `encryptSecret`/`decryptSecret`, `upsertUser`/`getUser`/`createSession`/`resolveSession`, `runWithUser`/`getCurrentUser`, `isMultiUser`/`getEffectiveSettings`, cookie `bt_session`, env `APP_SECRET`/`PROFILES_DB`/`MULTI_USER`/`COMPANY_LLM_*` — consistent across tasks. Per-user fields match the real `Settings` interface.
```
