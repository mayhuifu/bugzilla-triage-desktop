# Multi-user platform (internal, no-SSO) — design

**Date:** 2026-06-08
**Repo:** bugzilla-triage-desktop **Branch:** `multiuser-platform` (off `main` @ v0.6.0)
**Status:** Design approved (approach A); ready for implementation plan.

## Context

`bugzilla-triage-desktop` is today a **single-user Electron app**: a Next.js
server (already built `output: "standalone"`) wrapped by Electron. All config —
the Bugzilla API key, LLM provider+key, preferences — lives in **one
`settings.json`** read into a **process-global cache** (`loadSettings()` in
`lib/settings.ts`). `lib/bugzilla.ts` and `lib/llm.ts` read that global config.
There is **no auth, no sessions, no per-request identity**. Hosting it as-is
would make every user share one Bugzilla account + one LLM key (see the
multi-user analysis that motivated this work).

This spec turns it into a **multi-user platform for an internal company server**.

### Decisions locked in brainstorming
- **No SSO.** The platform is reachable **only inside the company network**;
  that perimeter is the security boundary. Identity is a lightweight
  **self-service setup** (email + Bugzilla API key + LLM config) → a per-user
  profile + a session cookie.
- **Per-user Bugzilla keys.** Each user's own key → Bugzilla enforces their
  permissions and attributes writes to them.
- **LLM:** per-user — the user's own provider/key **or** a company **DeepSeek**
  default (OpenAI-compatible, already supported by `lib/llm.ts`). External APIs
  are allowed from the server.
- **MVP = full triage, all users** (not search-only).
- **Scale: ≤ ~20 users, single Docker container on one internal Linux VM.**
  Read-only SQLite corpus shared in-process is sufficient; a small **writable
  SQLite** holds user profiles. No Postgres/OpenSearch/k8s.
- **Approach A:** AsyncLocalStorage + a dual-mode `getEffectiveSettings()` so the
  **shipped single-user desktop build keeps working from one codebase**.

## Goal

Run the existing app on an internal server where each employee, after a one-time
**/setup**, gets their own identity: triage/reads/writes act **as them** (their
Bugzilla key), AI uses **their** LLM config, and the read-only 3GPP corpus is
shared. One codebase serves both the **desktop** (single-user, global settings)
and the **server** (multi-user) via a `MULTI_USER` flag.

## Non-goals (explicit)
- No SSO/OIDC/SAML (network perimeter is the boundary; a clean seam is left to
  add it later in `withUser`).
- No horizontal scaling, k8s, OpenSearch, or Postgres (single VM, SQLite).
- No per-user LLM quota/billing engine — each user uses their own key, so cost
  is naturally theirs; the company-default (DeepSeek) is a shared opt-in key.
- No change to the corpus build pipeline or the desktop product's behavior.
- Not strong authentication — see Trust model. This is a deliberate internal-tool
  posture, documented, not an oversight.

## Approach A — AsyncLocalStorage + dual-mode config

The whole codebase reads per-user config through `loadSettings()`. We introduce
a request-scoped **`UserContext`** and a single seam:

- **`getEffectiveSettings()`** replaces direct `loadSettings()` reads of
  per-user fields. It returns:
  - **desktop mode** (`MULTI_USER` unset): the global `settings.json` (today's
    behavior, byte-identical).
  - **server mode** (`MULTI_USER=1`): the **current request's user** resolved
    from `AsyncLocalStorage`.
- **`withUser(handler)`** wraps each API route: reads the session cookie →
  loads that user's profile (decrypting secrets) → `runWithUser(ctx, handler)`
  so everything downstream (`bugzilla.ts`, `llm.ts`, triage) transparently uses
  that user's keys. No function signatures change.

```
[browser · internal network only]
   │ session cookie  (maps browser → user profile; httpOnly/secure/sameSite)
   ▼
middleware.ts ──no session──▶ 302 /setup
   │ session ok
   ▼
app/api/*/route.ts ── withUser() ─▶ resolve cookie → load+decrypt profile
   │                                  runWithUser({email,bugzillaKey,llm…}) {
   ▼
  handler → lib/bugzilla.ts  (getEffectiveSettings → ctx.bugzillaKey) → acts AS user
          → lib/llm.ts       (getEffectiveSettings → ctx.llm or company DeepSeek)
          → corpus retriever  (read-only shared SQLite; concurrent reads)
   }                          desktop mode: getEffectiveSettings → global file
```

**Why A:** smallest blast radius for a global-config retrofit (swap the *source*
of config, not every call site), and it keeps the desktop build alive. Rejected:
explicit `UserContext` param threading (churns every signature) and per-route
config objects (wide churn, no desktop-mode benefit).

## Components

| Kind | File(s) | Responsibility |
|---|---|---|
| **New** | `lib/users/store.ts` | Writable `profiles.db` (better-sqlite3, separate from the read-only corpus). Tables: `users(email TEXT PK, bugzilla_key_enc, llm_provider, llm_key_enc, llm_base_url, use_company_llm INTEGER, prefs_json, created_at, updated_at)`, `sessions(token TEXT PK, email, created_at, last_seen_at)`. CRUD + `resolveSession(token)`. Path from `PROFILES_DB` env (default `<dataDir>/profiles.db`). |
| **New** | `lib/users/crypto.ts` | AES-256-GCM encrypt/decrypt of stored secrets using a server master key (`APP_SECRET` env, required in server mode). `encryptSecret`/`decryptSecret`. Never log plaintext. |
| **New** | `lib/users/context.ts` | `AsyncLocalStorage<UserContext>`; `runWithUser(ctx, fn)`, `getCurrentUser()`, and `withUser(handler)` HOF for route handlers (reads cookie, loads profile, establishes ALS, 401/redirect if absent). |
| **New** | `app/setup/page.tsx` + `app/api/setup/route.ts` | Self-service onboarding: email + Bugzilla API key + LLM choice (own provider/key **or** "use company DeepSeek default"). "Test connection" reuses the logic behind `settings/test`. On success: upsert profile (encrypt secrets) → create session → set cookie → redirect to `/`. |
| **New** | `middleware.ts` | Server mode only: no valid session cookie → redirect page loads to `/setup` (and let `/setup`, static, and health through). |
| **New** | `Dockerfile` + `deploy/README.md` | Multi-stage build of the existing `.next/standalone` server into a container; env (`MULTI_USER=1`, `APP_SECRET`, `PROFILES_DB`, corpus volume); run behind a reverse proxy with HTTPS on the internal network. |
| **Change** | `lib/settings.ts` | Add `getEffectiveSettings()` (dual-mode). `loadSettings()` stays for desktop/global-only fields (corpus URL, theme). Per-user fields (`bugzillaApiKey`, `bugzillaLogin`, `llmProvider`, `anthropicApiKey`, `llmBaseUrl`, `defaultModel`) now sourced via `getEffectiveSettings()`. |
| **Change** | `lib/bugzilla.ts`, `lib/llm.ts` | Read per-user fields via `getEffectiveSettings()` instead of `loadSettings()`. Logic otherwise unchanged → act-as-user falls out for free. |
| **Change** | every `app/api/*/route.ts` (server mode) | Wrap in `withUser()`. **Decision: gate ALL routes** (incl. read-only corpus) behind a session — one uniform requirement; simpler than two tiers; reversible. |
| **Reused unchanged** | corpus retriever/embedder/reranker, all UI pages, the triage prompt, the `lib/bugzilla.ts`/`lib/llm.ts` request logic | Only the *source* of config changes. |
| **Kept** | `electron/` + desktop build | Untouched; server mode is an added deploy mode (`MULTI_USER=1`). |

## Data model (`profiles.db`)
- `users`: one row per employee, keyed by **email** (their self-claimed id).
  Secrets (`bugzilla_key_enc`, `llm_key_enc`) stored AES-256-GCM-encrypted.
  `use_company_llm=1` → ignore personal LLM fields, use the server's DeepSeek
  default (`COMPANY_LLM_*` env).
- `sessions`: opaque random token (the cookie value) → email, with `last_seen_at`
  for idle expiry. No passwords.

## Trust & security model (honest, deliberate)
- **Perimeter = internal network.** The session cookie is **identification, not
  strong authentication** — a person on the network holding another's cookie
  could impersonate them in the UI. Documented as a conscious internal-tool
  choice; the `withUser` seam is where real SSO would later attach.
- **Bugzilla/LLM actions are safe regardless of the above** — each uses the
  user's own key, so Bugzilla enforces their permissions + attributes writes,
  and LLM cost is on their key.
- **Secrets encrypted at rest** (`crypto.ts` + `APP_SECRET`); `APP_SECRET`
  absence in server mode is a hard startup error. Never logged.
- **Cookies:** `httpOnly`, `secure`, `sameSite=strict`; setup + all traffic over
  **HTTPS** (reverse proxy). Idle-expire sessions.
- **Hardening:** basic per-IP/per-session rate limiting on the LLM/triage routes;
  an **audit log** of Bugzilla writes (email · ticket · action · timestamp).

## Phasing (one design; the plan will break these into tasks)
1. **Identity foundation** — `store.ts` + `crypto.ts` + `context.ts` +
   `getEffectiveSettings()` dual-mode + `/setup` + session cookie. **Desktop mode
   unaffected** (verified: with `MULTI_USER` unset, behavior is byte-identical).
2. **Per-user wiring** — `withUser()` on all routes; `bugzilla.ts`/`llm.ts` via
   `getEffectiveSettings()`; `middleware.ts` setup-gate; company-DeepSeek default.
3. **Deploy + harden** — `Dockerfile`, reverse-proxy/HTTPS runbook, rate-limit,
   audit log, `APP_SECRET`/env validation.

## Acceptance criteria
1. **Desktop mode unchanged:** with `MULTI_USER` unset, the app behaves exactly
   as v0.6.0 (global `settings.json`, no setup gate). Regression-checked.
2. **Server mode, two users:** with `MULTI_USER=1`, User A and User B each
   `/setup` with their own email + Bugzilla key + LLM config; concurrent requests
   each use their own keys; a triage write by A is attributed to A in Bugzilla,
   by B to B. No cross-contamination of keys.
3. **No session → `/setup`** (pages) / 401 (API) in server mode.
4. **Secrets at rest are encrypted** in `profiles.db` (no plaintext keys);
   missing `APP_SECRET` hard-fails startup in server mode.
5. **Company DeepSeek default:** a user choosing "use company LLM" triages
   without supplying a personal LLM key.
6. **Runs as a container** behind a reverse proxy on the internal network;
   `deploy/README.md` reproduces it.
7. Corpus search/triage work concurrently for multiple users (read-only corpus
   shared).

## Risks
- **ALS correctness across async/subprocess boundaries.** Mitigation: establish
  ALS in `withUser` (Node runtime route handlers); verify it survives `await`
  and the LLM subprocess/API path with the two-user test. If a leak is found,
  fall back to explicit context on the affected path.
- **Missed `loadSettings()` call site** still reading global config in server
  mode → wrong user. Mitigation: grep audit of all `loadSettings()` uses during
  the wiring phase; the two-user test catches cross-contamination.
- **Cookie impersonation** (trust model) — accepted; documented; SSO seam left.
- **Single VM availability/backup** — `profiles.db` must be on a backed-up
  volume (it holds the only copy of users' encrypted keys). Noted in deploy docs.
- **better-sqlite3 sync serialization** under load — fine at ≤20 users; if it
  bites, the corpus read path is the place to move to OpenSearch later (the
  retriever already sits behind an interface).

## Future seam
SSO (OIDC against Entra/Okta) attaches at `withUser` (replace the cookie→profile
resolution with an IdP-validated identity), and scale-up swaps SQLite→Postgres
(profiles) / OpenSearch (corpus) behind their existing interfaces — neither
requires touching the per-request `getEffectiveSettings()` contract.
