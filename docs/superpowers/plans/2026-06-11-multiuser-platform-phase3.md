# Multi-user Platform — Phase 3 (Deployment + Hardening) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the multi-user server deployable by IT — a Docker image + compose stack with HTTPS reverse proxy, plus the two production-hardening pieces (per-user rate limiting on LLM routes, append-only audit log of Bugzilla writes) and an IT-facing runbook.

**Architecture:** Multi-stage Dockerfile builds the Next standalone payload and copies the three things the tracer can't see (bge ONNX model at `<cwd>/models`, `sqlite-vec-linux-*` platform package, static assets). One `/data` volume (via `XDG_CONFIG_HOME`) holds corpus + profiles + audit log. Caddy terminates HTTPS in front (the `Secure` session cookie makes HTTPS mandatory off-localhost). Rate limit + audit are tiny in-process modules gated on `MULTI_USER` — desktop stays byte-identical.

**Tech Stack:** Docker (node:20-bookworm-slim), docker-compose, Caddy 2 (nginx alternative documented), Node `fs.appendFileSync` JSONL audit, in-memory sliding-window limiter.

---

## Standing constraints
- Work on `main` (multiuser-platform is merged). Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Desktop byte-identical: every new behavior is behind `isMultiUser()` / `MULTI_USER=1`.
- No test runner → verification = `npx tsc --noEmit`, grep-audits, and a **standalone-layout boot smoke** (assemble `.next/standalone` exactly as the Dockerfile does and boot it — same layout the container runs).

## Deployment facts this plan is built on (verified)
- `next.config.mjs`: `output: "standalone"`; externals `better-sqlite3`, `pdfjs-dist`, `@huggingface/transformers`, `onnxruntime-node` (traced into `.next/standalone/node_modules`).
- Embedder: `lib/corpus/embedder-bge.ts` resolves the model at `<cwd>/models/Xenova/bge-small-en-v1.5/` (`config.json` presence check). `npm run fetch:model` stages it (~56 MB, gitignored).
- sqlite-vec: `lib/corpus/store.ts:324` loads `<cwd>/node_modules/sqlite-vec-<platform>-<arch>/vec0.<ext>` via dynamic require — **not traced**; must be copied into the runtime image explicitly.
- App data: `lib/paths.ts` → Linux: `$XDG_CONFIG_HOME/bugzilla-triage-desktop` → set `XDG_CONFIG_HOME=/data`, volume `/data` (corpus + settings); `PROFILES_DB=/data/profiles.db`.
- Session cookie is `Secure` → off-localhost requires HTTPS → reverse proxy is part of the deployment, not optional.
- Unauthenticated health endpoint: `GET /api/setup`.
- Bugzilla writes all happen inside `submit()` in `lib/bugzilla.ts` (comment `bzPost` ~512, label `bzPut` ~527, status `bzPut` ~535).
- LLM-spending routes: `app/api/tickets/[id]/triage/route.ts`, `.../triage/followup/route.ts`, `app/api/corpus/search/route.ts` (only when `?rerank=llm`).

## File structure

| File | Action | Responsibility |
|---|---|---|
| `lib/audit.ts` | Create | `auditBugzillaWrite()` — append JSONL `{ts,user,action,bugId}` to `AUDIT_LOG` (default `<appDataDir>/audit.log`); server-mode only; never throws. |
| `lib/bugzilla.ts` | Modify | Call audit after each of the three writes in `submit()`. |
| `lib/users/rate-limit.ts` | Create | `allowRate(bucket,maxPerMinute)` — per-user sliding window; desktop always allowed. |
| `app/api/tickets/[id]/triage/route.ts` + `followup` + `corpus/search` | Modify | 429 when over per-user budget (`RATE_TRIAGE_PER_MIN`=6, `RATE_RERANK_PER_MIN`=20). |
| `Dockerfile`, `.dockerignore` | Create | Multi-stage build → standalone runtime image, non-root, healthcheck. |
| `deploy/docker-compose.yml`, `deploy/Caddyfile`, `deploy/.env.example` | Create | App + HTTPS proxy stack. |
| `deploy/README.md` | Create | IT runbook: env table, certs, backup, upgrade, smoke checklist, troubleshooting. |
| `package.json`, `RELEASES.md` | Modify | v0.7.0 — multi-user server platform. |

---

## Task 1: Audit log of Bugzilla writes

**Files:** Create `lib/audit.ts`; Modify `lib/bugzilla.ts` (`submit()`)

- [ ] **Step 1:** Create `lib/audit.ts`:

```typescript
// lib/audit.ts — append-only audit trail of Bugzilla WRITES in server mode.
// One JSON object per line ({ts, user, action, bugId, detail?}) so IT can
// grep/jq it. Desktop mode is exempt (single user, their own key). Auditing
// must never break the write it records — all failures are swallowed.
import "server-only";
import * as fs from "node:fs";
import * as path from "node:path";
import { appDataDir } from "./paths";
import { isMultiUser } from "./settings";
import { getCurrentUser } from "./users/context";

function auditPath(): string {
  return process.env.AUDIT_LOG || path.join(appDataDir(), "audit.log");
}

export function auditBugzillaWrite(action: "comment" | "label" | "status", bugId: number | string, detail?: string): void {
  if (!isMultiUser()) return;
  try {
    const rec = {
      ts: new Date().toISOString(),
      user: getCurrentUser()?.email ?? "(no-session)",
      action,
      bugId: Number(bugId),
      ...(detail ? { detail } : {}),
    };
    fs.mkdirSync(path.dirname(auditPath()), { recursive: true });
    fs.appendFileSync(auditPath(), JSON.stringify(rec) + "\n");
  } catch { /* never block the Bugzilla write */ }
}
```

- [ ] **Step 2:** In `lib/bugzilla.ts` add `import { auditBugzillaWrite } from "./audit";` and after each write in `submit()`:
  - after `const commentRes = await bzPost(\`/rest/bug/${id}/comment\`, …)` → `auditBugzillaWrite("comment", id);`
  - after `await bzPut(\`/rest/bug/${id}\`, { cf_label: mergedLabel });` → `auditBugzillaWrite("label", id);`
  - after the status `await bzPut(\`/rest/bug/${id}\`, payload);` → `auditBugzillaWrite("status", id, transitionTo);`

- [ ] **Step 3:** `npx tsc --noEmit` → zero errors. Commit `feat(platform): append-only audit log of Bugzilla writes (server mode)`.

## Task 2: Per-user rate limit on LLM routes

**Files:** Create `lib/users/rate-limit.ts`; Modify the three routes.

- [ ] **Step 1:** Create `lib/users/rate-limit.ts`:

```typescript
// lib/users/rate-limit.ts — tiny in-memory sliding-window limiter for the
// LLM-spending routes in server mode (≤20 users on one VM → a Map is the
// whole implementation). Desktop mode: always allowed (byte-identical).
import "server-only";
import { isMultiUser } from "@/lib/settings";
import { getCurrentUser } from "./context";

const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

/** True when the current user may proceed; false → caller should 429. */
export function allowRate(bucket: string, maxPerMinute: number): boolean {
  if (!isMultiUser()) return true;
  const who = getCurrentUser()?.email ?? "anon";
  const key = `${bucket}:${who}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= maxPerMinute) { hits.set(key, recent); return false; }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

export function rateEnv(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
```

- [ ] **Step 2:** Apply — first statement inside the wrapped handler body:
  - `triage/route.ts` + `triage/followup/route.ts`:
    ```typescript
    if (!allowRate("triage", rateEnv("RATE_TRIAGE_PER_MIN", 6))) {
      return NextResponse.json({ error: "Rate limit: too many AI triage runs — try again in a minute." }, { status: 429 });
    }
    ```
  - `corpus/search/route.ts`: only when the request asked for the LLM reranker (after `rerank` is parsed): same shape with `allowRate("rerank", rateEnv("RATE_RERANK_PER_MIN", 20))`.

- [ ] **Step 3:** `npx tsc --noEmit` → zero. Commit `feat(platform): per-user rate limit on LLM routes (server mode)`.

## Task 3: Dockerfile + .dockerignore

- [ ] **Step 1:** Create `.dockerignore` (keep the build context lean; **models/ stays included** so a pre-staged model survives an offline build):

```
node_modules
.next
dist
out
.git
.env*
*.log
docs
.claude
```

- [ ] **Step 2:** Create `Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
# Multi-user server image. Desktop installers are unaffected (electron-builder
# path is separate). Build: docker build -t bugzilla-triage:0.7.0 .
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Stage the query-time embedder (~56 MB). On an offline build host, pre-run
# `npm run fetch:model` on a connected machine and ship models/ in the build
# context — the `|| true` keeps an already-staged model from failing the build.
RUN test -f models/Xenova/bge-small-en-v1.5/config.json || npm run fetch:model
RUN npm run build

FROM node:20-bookworm-slim AS run
ENV NODE_ENV=production \
    MULTI_USER=1 \
    XDG_CONFIG_HOME=/data \
    PROFILES_DB=/data/profiles.db \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# Next standalone payload (traced node_modules incl. better-sqlite3 / onnxruntime)
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Embedder model — resolved from <cwd>/models at runtime
COPY --from=build /app/models ./models
# sqlite-vec platform package — loaded via dynamic require from <cwd>/node_modules,
# invisible to the standalone tracer, so copy it explicitly (glob covers x64/arm64)
COPY --from=build /app/node_modules/sqlite-vec-linux-* ./node_modules/
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/setup').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
```

  ⚠ The `COPY …/sqlite-vec-linux-* ./node_modules/` glob flattens into `node_modules/` — verify the resulting path is `node_modules/sqlite-vec-linux-x64/vec0.so` (Docker copies *directory contents* on glob matches; if it flattens wrongly, switch to an explicit `COPY --from=build /app/node_modules/sqlite-vec-linux-x64 ./node_modules/sqlite-vec-linux-x64`). The standalone smoke (Task 6) catches this class of bug locally; the in-container check is in the README smoke list.

- [ ] **Step 3:** Commit `feat(deploy): multi-stage Dockerfile for the multi-user server`.

## Task 4: Compose stack + Caddy

- [ ] **Step 1:** Create `deploy/docker-compose.yml`:

```yaml
# Multi-user Bugzilla AI Triage — app + HTTPS reverse proxy.
# HTTPS is REQUIRED off-localhost: the session cookie is Secure and browsers
# drop it over plain http on a LAN address (logins silently fail).
services:
  app:
    build: ..
    restart: unless-stopped
    env_file: .env
    volumes:
      - btdata:/data
    expose:
      - "3000"
  proxy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./certs:/certs:ro          # drop company cert/key here (optional)
      - caddy_data:/data
      - caddy_config:/config
volumes:
  btdata:
  caddy_data:
  caddy_config:
```

- [ ] **Step 2:** Create `deploy/Caddyfile`:

```
# Replace with the DNS name IT assigns. Two TLS options:
#   tls internal                  → Caddy mints its own CA (browsers warn once;
#                                   fine for a deployment TEST)
#   tls /certs/cert.pem /certs/key.pem → company-issued cert (production)
triage.internal.example.com {
	tls internal
	reverse_proxy app:3000
}
```

- [ ] **Step 3:** Create `deploy/.env.example`:

```bash
# ── Required ──────────────────────────────────────────────────────────────
# Session + at-rest encryption key for user profiles. Generate once:
#   openssl rand -hex 32
# CHANGING IT ORPHANS EXISTING PROFILES (they can no longer be decrypted).
APP_SECRET=

# The company Bugzilla every user shares (their own API keys act on it).
BUGZILLA_URL=https://ticketing.internal.umsemi.com
BUGZILLA_INSECURE=true

# ── Company LLM (what "Use company AI" in /setup resolves to) ────────────
COMPANY_LLM_PROVIDER=openai-compatible
COMPANY_LLM_BASE_URL=https://api.deepseek.com
COMPANY_LLM_API_KEY=
COMPANY_LLM_MODEL=deepseek-chat

# ── Optional knobs (defaults shown) ───────────────────────────────────────
#RATE_TRIAGE_PER_MIN=6
#RATE_RERANK_PER_MIN=20
#AUDIT_LOG=/data/audit.log
#CORPUS_MANIFEST_URL=   # only for an internal corpus mirror
```

- [ ] **Step 4:** Commit `feat(deploy): compose stack with Caddy HTTPS proxy + env template`.

## Task 5: IT runbook — `deploy/README.md`

- [ ] **Step 1:** Write the runbook covering: prerequisites (Docker + compose, DNS name, network route to Bugzilla + api.deepseek.com, x64 host); 5-step install (clone → `cp .env.example .env` + fill → edit Caddyfile hostname → `docker compose up -d --build` → open `https://<host>/` and complete `/setup`); env table (every var from .env.example + PROFILES_DB/XDG_CONFIG_HOME baked into the image); data layout (`/data` volume: corpus ~170 MB downloaded on first use, profiles.db, audit.log) + backup = snapshot the volume + keep APP_SECRET; upgrade = `git pull && docker compose up -d --build` (profiles survive in the volume); smoke checklist (health endpoint 200, `/` redirects to `/setup`, no-session API → 401, two-browser two-user test pointer to `scripts/dev-multiuser-smoke.sh`, corpus downloads, audit.log shows a line after a submit, in-container `ls node_modules/sqlite-vec-linux-x64/vec0.so` + `ls models/Xenova/bge-small-en-v1.5/config.json`); troubleshooting (login won't stick = HTTPS/cookie problem; "Bugzilla key check failed" = network route or BUGZILLA_INSECURE; vec0 missing = COPY glob flattened — see Dockerfile note; model missing = offline build without pre-staged models/).

- [ ] **Step 2:** Commit `docs(deploy): IT runbook for the multi-user server`.

## Task 6: Verification — standalone-layout boot smoke

- [ ] **Step 1:** `npx tsc --noEmit` → zero. Desktop-invariant grep: every new module gates on `isMultiUser()`/`MULTI_USER`.
- [ ] **Step 2:** Assemble the exact container layout locally and boot it:

```bash
npm run build
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
cp -r models .next/standalone/models
mkdir -p .next/standalone/node_modules
cp -r node_modules/sqlite-vec-darwin-* .next/standalone/node_modules/ 2>/dev/null || true
cd .next/standalone && MULTI_USER=1 APP_SECRET=smoke0123 PROFILES_DB=/tmp/p3.db \
  BUGZILLA_URL=http://127.0.0.1:9 PORT=3100 node server.js
```

Then: `GET :3100/api/setup` → `{multiUser:true}`; `GET :3100/api/whoami` → 401; `GET :3100/` → 307 to `/setup`; corpus status reports the engine (proves sqlite-vec + model resolution from the standalone cwd). 429 check: hammer `POST /api/tickets/1/triage` 7× with a session-less curl is blocked by 401 first — rate-limit correctness is asserted by code review + the two-user harness can exercise it post-deploy.
- [ ] **Step 3:** If `docker` is available locally, also `docker build .`; otherwise IT's first build is the check (the standalone smoke covers the same layout).

## Task 7: Ship v0.7.0

- [ ] `package.json` version → `0.7.0`; `RELEASES.md` entry (multi-user platform: per-user identity + act-as-user + gating + rate limit + audit + Docker deploy). Commit `release: v0.7.0 — multi-user server platform (Phases 1-3)`, push main. (Tagging/installer builds: on request.)

---

## Self-review
**Spec coverage:** Dockerfile ✓ (T3), reverse-proxy/HTTPS runbook ✓ (T4+T5), rate-limit ✓ (T2), audit log ✓ (T1), COMPANY_LLM_* docs ✓ (T4 env + T5 table), backup/upgrade ✓ (T5), IT smoke ✓ (T5+T6). **Placeholders:** T5 is a content outline rather than verbatim prose — acceptable for docs (every section's content is specified); all code tasks carry full code. **Consistency:** `allowRate`/`rateEnv`/`auditBugzillaWrite` names used consistently; env names match between Dockerfile, .env.example, and limiter.
