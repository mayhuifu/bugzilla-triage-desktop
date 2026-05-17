# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Next.js dev server on http://localhost:3000
- `npm run build` / `npm start` — production build / serve
- `npm run lint` — `next lint` (no test runner is configured)

There is no test suite. Manual verification is via the dev server (the README has a demo walkthrough). Use `?mock=1` on any `/api/tickets*` URL to force the mock data path without hitting Bugzilla.

## Architecture

This is a Next.js 15 (App Router, React 19, TypeScript strict) dashboard that wraps an **external** repo (`bugzilla-mcp`, expected as a peer directory) to triage Bugzilla tickets with the user's local Claude Code subscription. The Next.js server-side code is intentionally thin — all Bugzilla logic and triage prompting live in Python.

### The three-layer call stack

Browser → Next.js API route (`app/api/tickets/**/route.ts`) → Python bridge subprocess (`scripts/*.py`) → either Bugzilla REST (via `../bugzilla-mcp/skills/`) or the `claude` CLI.

`lib/bridge.ts` is the only place that spawns subprocesses. It always invokes Python via `uv run --directory $BUGZILLA_MCP_PATH --with requests --with urllib3 python …` so:
- the venv is auto-provisioned (no `pip install` step on fresh checkouts), and
- the Python interpreter's CWD is the `bugzilla-mcp` repo, which is what `skills/bugzilla_analyze.py` expects when it reads `.mcp.json`.

The contract between TS and Python is **one line of JSON on stdout** (last line only — anything before it is treated as logs). Errors are surfaced as `{"error": "..."}` on stdout, *not* by exit code alone. `runBridge` parses the last stdout line and rejects on `error` field; see [lib/bridge.ts:64-83](lib/bridge.ts:64).

### Why a Python bridge instead of porting to TS

The peer `bugzilla-mcp` repo encodes the umsemi-specific workflow rules — `"Analyzed by AI Triage Bot:"` comment prefix (renamed from `"Analyzed by Claude:"` in v0.1.3 so it stays accurate when triage runs against non-Anthropic providers), the matching `Analyzed by AI Triage Bot` `cf_label`, the allowed resolution vocabulary, the 4-layer OBSERVED/INFERRED/HYPOTHESIS/NEXT-STEPS scaffold, and the 3GPP domain classifier. Reimplementing these in TS would drift. Treat `scripts/bz_bridge.py` and `scripts/triage_llm.py` as thin adapters; **the source of truth for triage conventions is in `../bugzilla-mcp/skills/`**, not in this repo.

### Credentials & path resolution

Bugzilla creds are **never** stored here. `bz_bridge.py` finds `bugzilla-mcp` via this order, then reads its `.mcp.json` and pushes `BUGZILLA_URL` / `BUGZILLA_API_KEY` / `BUGZILLA_INSECURE` / `BUGZILLA_LOGIN` into the env for the skills:
1. `$BUGZILLA_MCP_PATH`
2. `../bugzilla-mcp/` (peer dir — default)
3. `~/bugzilla-mcp/`

If you need to change this, edit `find_bugzilla_mcp_path()` in `scripts/bz_bridge.py` — `lib/bridge.ts` mirrors the same env var.

### AI triage path

`scripts/triage_llm.py` invokes the **local `claude` CLI** in headless mode (`-p --output-format json --append-system-prompt … --permission-mode bypassPermissions --disallowedTools …`). This intentionally uses the user's Claude Code subscription rather than an Anthropic API key. The schema in `TRIAGE_SCHEMA` and `SYSTEM_PROMPT` must stay in sync with the `TriageResult` interface in [lib/types.ts:88](lib/types.ts:88) — both sides are consumed by `components/triage/TriageChatPanel.tsx`. Output is extracted from a `\`\`\`json … \`\`\`` fence in the model's response.

The model defaults to whatever `claude` picks; pass `?model=sonnet` on the triage endpoint to override. Cold start carries ~36k tokens of Claude Code system prompt (cache miss); subsequent calls within 5 min hit the cache.

### Graceful-fallback pattern

Every `/api/tickets*` route catches bridge errors and returns mock data with a `source: "mock-fallback"` field and the underlying error message. The frontend reads `source` to render a warning badge. **Don't remove this fallback** — it keeps demos running when VPN drops or Bugzilla's self-signed SSL fails. Pattern: see [app/api/tickets/route.ts:32-40](app/api/tickets/route.ts:32).

`MOCK_SUMMARIES` / `MOCK_DETAILS` in [lib/mock-data.ts](lib/mock-data.ts) are deliberately curated for the demo script in the README (ticket #16026 is the frequency-offset bug walked through with the CEO).

### Submit path safety

`POST /api/tickets/:id/submit` is the only endpoint that **mutates** Bugzilla. The comment body is piped via a tmp file to avoid shell-arg length limits ([lib/bridge.ts:132-150](lib/bridge.ts:132)). The Python skill auto-prefixes `"Analyzed by AI Triage Bot:"` and adds the `"Analyzed by AI Triage Bot"` `cf_label`, so the model is told **not** to include either in `bugzillaComment` — adding them in TS would double-prefix. (Both strings were `"Analyzed by Claude…"` up through v0.1.2; renamed in v0.1.3.)

### 3GPP RAG corpus (added v0.1.6 / v0.1.7)

The AI triage path enriches model output with real spec text from a downloadable SQLite corpus (Release-17 NR + LTE, 5,631 clauses, FTS5 BM25). Source of truth for the corpus build lives in a **separate repo** [bugzilla-triage-corpus](https://github.com/mayhuifu/bugzilla-triage-corpus) — that's where DOCX parsing, chunking, and the artifact-publish pipeline run.

In this app, `lib/corpus/` holds the runtime read-only consumer:
- `store.ts`: lazy `better-sqlite3` singleton, opens `<userData>/corpus/corpus.sqlite` when present, returns `null` when absent (every caller graceful-no-ops)
- `retriever.ts`: `retrieveContext(ticket)` for pre-triage BM25 (top-K=6, OR-joined query because FTS5's default AND is too restrictive for noisy tickets) + `lookupClause(citation)` for post-triage exact-match enrichment
- `downloader.ts`: streams the corpus from a configurable `corpusManifestUrl`, sha256-verifies, gunzips, atomically renames into place
- `manifest.ts`: local sidecar + remote manifest fetch + tag comparison for update detection

The retrieval is glued into the triage pipeline at two points: `app/api/tickets/[id]/triage/route.ts` calls `retrieveContext` before the LLM and passes results through to `runTriage`, which injects them into the user prompt and (after parse) calls `enrichExcerptsWithCorpus` to look up each cited reference. The `SpecExcerpt` type in `lib/types.ts` now has optional `realText` / `title` / `parentTitle` / `clauseId` / `source` fields that get populated by the corpus path.

The `corpusManifestUrl` setting is the China-friendliness lever: GitHub is blocked in mainland China, so the user can override the default GH Releases URL to an internal mirror (SharePoint, S3, Confluence). The manifest's `artifact.url` field flows transitively, so a single override redirects both the manifest and the corpus.

The native binding (`better-sqlite3`'s `.node` file) is shipped via electron-builder's `asarUnpack` + explicit `extraResources` entries — don't refactor `electron-builder.json` without preserving those.

### Release notes

`RELEASES.md` in the repo root is the canonical changelog — entries land **there first**, before the tag is cut, then get pasted into the GitHub Release body when CI finishes. The template at the bottom of that file documents the format (sections: Highlights, Changes, Upgrade notes) and the publishing steps. Whoever cuts the tag should also update `RELEASES.md` in the same commit as the `package.json` version bump.

## Conventions

- `@/*` alias maps to repo root (see `tsconfig.json`).
- API routes use `export const dynamic = "force-dynamic"` — they spawn subprocesses, so caching would be wrong.
- The dashboard intentionally has no auth — it assumes deployment behind corporate SSO/VPN.
- Severity, status, and resolution vocabularies are umsemi-specific (e.g. `IN_ANALYSIS`, `ANALYZED` are not stock Bugzilla statuses). See [lib/types.ts:7-17](lib/types.ts:7) and don't add stock-Bugzilla aliases.
