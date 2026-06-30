# Deploying the multi-user Bugzilla AI Triage server

This directory deploys the app as a **multi-user web service** for the team
(each engineer signs in once at `/setup` with their email + their own Bugzilla
API key; all Bugzilla actions are attributed to the acting user). The desktop
installers are unaffected — this is a separate, server-only path.

## Prerequisites

- A Linux **x64** VM with Docker + the compose plugin (`docker compose version`).
- A DNS name for the service (e.g. `triage.internal.example.com`) pointing at the VM.
- Network routes from the VM to:
  - the company Bugzilla (e.g. `ticketing.internal.umsemi.com`),
  - the company LLM endpoint (e.g. `api.deepseek.com`),
  - `github.com` — only if you install the optional 3GPP corpus from the default
    source (see "3GPP spec corpus" below); an internal mirror replaces it via
    `CORPUS_MANIFEST_URL`, or mount a prebuilt file for a fully-offline install.
- Sized for ≤ ~20 concurrent users on one VM (2 vCPU / 4 GB RAM is plenty).

## Install (5 steps)

```bash
git clone https://github.com/mayhuifu/bugzilla-triage-desktop.git
cd bugzilla-triage-desktop/deploy

cp .env.example .env        # 1. fill in APP_SECRET (openssl rand -hex 32),
                            #    BUGZILLA_URL, COMPANY_LLM_API_KEY
vi Caddyfile                # 2. set the real hostname; keep `tls internal`
                            #    for the test, or point at company certs
docker compose up -d --build   # 3. build (~5-10 min first time) + start
docker compose ps              # 4. wait for app: healthy
# 5. open https://<hostname>/ in a browser → you land on /setup
```

> **Offline build host?** Run `npm run fetch:model` on a connected machine
> first and copy the repo (with `models/` populated) to the build host — the
> Dockerfile detects the staged model and skips the download.

## 3GPP spec corpus (optional, shared — installed once by you)

The corpus lets AI triage cite real Rel-17 NR/LTE spec excerpts instead of
paraphrasing from training data. In server mode it's a **single shared file** on
the `/data` volume that every user reads — there is **no per-user download**
(individual users are never prompted). It's optional: triage still works without
it (model paraphrase).

Install it **once**, after the server is up:

```bash
# default source = the corpus repo's GitHub release:
docker compose exec app node scripts/install-corpus.mjs

# behind the Great Firewall / offline → point at an internal mirror hosting the
# same manifest.json + .sqlite.gz (the manifest's artifact.url decides where the
# .gz is fetched):
docker compose exec -e CORPUS_MANIFEST_URL=https://mirror.internal/3gpp-corpus.manifest.json \
    app node scripts/install-corpus.mjs

# replace an installed corpus (e.g. a newer rel17 build):
docker compose exec app node scripts/install-corpus.mjs --force
```

It downloads → verifies sha256 → atomically installs to
`/data/bugzilla-triage-desktop/corpus/corpus.sqlite`, and is idempotent (re-runs
are a no-op unless `--force`). Restart the app (`docker compose restart app`) if
it was already running so it reopens the file; the next Spec search / triage on
any account then uses it.

**Fully offline alternative — mount a prebuilt file** (no network at all):

```yaml
# in docker-compose.yml, under the app service:
volumes:
  - btdata:/data
  - /opt/zilla/corpus.sqlite:/data/bugzilla-triage-desktop/corpus/corpus.sqlite:ro
```

## Environment reference

| Variable | Required | Meaning |
|---|---|---|
| `APP_SECRET` | ✅ | Derives the session + profile-encryption key (AES-256-GCM). Generate once, keep stable — changing it orphans all profiles. |
| `BUGZILLA_URL` | ✅ | The shared company Bugzilla. Server-controlled; users only bring their API key. |
| `BUGZILLA_INSECURE` | – | `true` (default) accepts Bugzilla's self-signed/internal TLS cert. |
| `COMPANY_LLM_PROVIDER` / `_BASE_URL` / `_API_KEY` / `_MODEL` | ✅ for "company AI" | What the "Use company AI (DeepSeek)" choice in `/setup` resolves to. Users picking "my own provider" use their own key instead. |
| `RATE_TRIAGE_PER_MIN` | – | Per-user AI-triage budget (default 6/min → HTTP 429 above it). |
| `RATE_RERANK_PER_MIN` | – | Per-user AI-reranked-search budget (default 20/min). |
| `AUDIT_LOG` | – | JSONL audit trail of Bugzilla writes (default `/data/audit.log`). |
| `CORPUS_MANIFEST_URL` | – | Internal mirror for the 3GPP corpus artifact. |
| `MULTI_USER`, `XDG_CONFIG_HOME=/data`, `PROFILES_DB=/data/profiles.db`, `PORT` | baked into the image | Don't override unless you know why. |

## Data, backup, upgrade

Everything stateful lives in the **`btdata` volume**, mounted at `/data`:

```
/data/bugzilla-triage-desktop/corpus/corpus.sqlite   # 3GPP corpus (~170 MB, re-downloadable)
/data/profiles.db                                    # user profiles + sessions (encrypted keys)
/data/audit.log                                      # who wrote what to Bugzilla, when
```

- **Backup** = snapshot the `btdata` volume **and** keep the `.env` (the
  `APP_SECRET` in it is required to decrypt profiles). The corpus needs no
  backup — it re-downloads.
- **Upgrade**: `git pull && docker compose up -d --build`. Profiles, sessions,
  corpus and audit log survive in the volume.
- **Audit queries**: `docker compose exec app sh -c 'cat /data/audit.log'` —
  one JSON object per line: `{ts, user, action: comment|label|status, bugId}`.

## Smoke checklist (deployment test)

1. `curl -ks https://<host>/api/setup` → `{"multiUser":true,"hasSession":false}`.
2. Opening `https://<host>/` in a browser redirects to `/setup`.
3. `curl -ks https://<host>/api/whoami` → HTTP 401 (`setup required`).
4. Complete `/setup` with a real email + Bugzilla API key → lands on the
   dashboard, tickets load, identity in the header is yours.
5. **Two-user attribution** (the core test): second person (or second browser
   profile) sets up with *their* key; each runs an AI triage and submits — the
   Bugzilla comments are authored by the respective person. Details/gotchas:
   `scripts/dev-multiuser-smoke.sh` in the repo root.
6. 3GPP corpus (optional): run `docker compose exec app node scripts/install-corpus.mjs`
   once (see "3GPP spec corpus" above), then open the Spec page and search →
   results cite real clauses. Skip it and triage still works (paraphrase).
7. After a submit: `audit.log` gained a line with the submitter's email.
8. In-container sanity (only if something's off):
   `docker compose exec app ls node_modules/sqlite-vec-linux-x64/vec0.so models/Xenova/bge-small-en-v1.5/config.json`

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Login/setup succeeds but you're bounced back to `/setup`; APIs 401 | The session cookie was dropped → you're not on HTTPS (or you're on a bare IP with `http://`). Use the `https://<dns-name>/` URL through the proxy. |
| `/setup` says "Bugzilla key check failed: …" | The VM can't reach `BUGZILLA_URL` (route/VPN/firewall), or the key is wrong, or set `BUGZILLA_INSECURE=true` for self-signed certs. |
| Spec search works but logs say `sqlite-vec not loaded … BM25-only` | `vec0.so` missing in the image — check item 8 above (the dir is `sqlite-vec-linux-x64` on x64 hosts, `-arm64` on ARM; the image arch follows the build host). |
| Spec search has no semantic matches / embedder errors | `models/` wasn't staged at build (offline host) — see the offline-build note. |
| HTTP 429 on triage | Per-user rate limit — raise `RATE_TRIAGE_PER_MIN` in `.env` and `docker compose up -d`. |
| Browser warns about the certificate | `tls internal` test mode — accept once, or install company certs (`deploy/certs/` + Caddyfile `tls /certs/cert.pem /certs/key.pem`). |
