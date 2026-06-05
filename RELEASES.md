# Release notes

Single source of truth for what shipped in each tagged release. New entries land **here first**, then get pasted into the GitHub Release page when the artifacts are published. Most recent at the top.

> **Workflow** (do this every time a new tag is cut):
>
> 1. Bump `package.json#version` to the next tag (e.g. `0.1.8`).
> 2. **Write the entry below** for that version using the template at the bottom of this file. Commit it together with the version bump.
> 3. Tag the commit (`git tag -a vX.Y.Z -m "…"; git push origin vX.Y.Z`). CI auto-builds installers into a draft release.
> 4. After CI finishes, copy the section from this file into the GitHub Release's body (`gh release edit vX.Y.Z --notes-file <(awk '...')` if you want to script it, or paste manually) and flip `--draft=false` to publish.
> 5. Keep this file as the canonical changelog — it's what users browsing the repo read.

---

## v0.5.5 — Hit-rank fix: conformance-test-spec demotion (next-gen RAG Phase A)

**Tagged:** _pending_
**Published:** _pending_

### Highlights

Phase A of the next-gen RAG work (`PLAN-nextgen-rag.md`). The goal was the
maintainer's "RAG hit-rank doesn't work well for some cases." We built the
planned cross-encoder reranker AND an eval harness to prove it — and the eval
sent us somewhere better.

- **Conformance-test specs are now demoted below normative clauses in all
  retrieval.** The corpus carries 3GPP *test* specs (38.523-1, 38.521-\*,
  38.508-1, 36.523-1, 36.521-\*, 36.508) alongside the normative specs. Their
  test-procedure clauses share heavy vocabulary with bug summaries and were
  **flooding the candidate pool, burying the normative clause** an engineer
  actually wants. Demoting them (they still appear, just ranked under normative
  clauses) lifted retrieval on the verified eval set (63 queries, acceptable-
  answer scoring): **R@1 20.6% → 30.2% (+9.6pp)**, **MRR@10 34.0 → 43.8
  (+9.8pp)**, **R@10 61.9% → 65.1%** — the right answers were always retrieved,
  just buried. Disable with `CORPUS_DEMOTE_TEST_SPECS=0`.
- **The planned cross-encoder reranker ships DORMANT.** It's fully implemented
  (`lib/corpus/reranker*.ts`, wired into the hybrid path, status + `/spec`
  badge) but **off by default** (`CORPUS_RERANK=1` to enable) because the eval
  showed both candidate models (ms-marco-MiniLM-L-6-v2 and bge-reranker-base)
  *regress* top-1 by 2–6pp on 3GPP normative-clause retrieval — general
  web-search cross-encoders misalign with normative relevance. Full analysis:
  `EVAL-v0.5.5-reranker-findings.md`. No reranker model is bundled, so the
  installer doesn't grow.
- **Reproducible eval harness.** `scripts/dev-rerank-eval.mjs` measures
  MRR@10 / R@1 / R@10 for hybrid vs hybrid+rerank (and the test-spec
  down-weight) against the corpus + eval set, with acceptable-answer-set
  scoring. `scripts/eval-curation-report.mjs` characterises each query
  (exists / leaf / rank / mode).
- **Verified eval set.** The corpus eval set (`scripts/eval-queries.json`) was
  verified (every clause id exists as a leaf), stratified by retrieval mode
  (top1 / ranked-low / recall-miss), and given **acceptable-answer sets** so a
  defensible sibling answer (e.g. the specific procedure clause vs the
  section's «General» stub) stops counting as a miss.

Desktop-only — no corpus rebuild, still `rel17-v5`, no schema change. Older
corpora are unaffected (demotion is a no-op when no test specs are present).

---

## v0.5.1 — Spec drawer: figure & table rendering fixes

**Tagged:** 2026-06-01
**Published:** 2026-06-01

### Highlights

Polish pass on the 3GPP spec drawer (`SpecDrawer`), all rendering-side — no
corpus rebuild. Found while spot-checking real clauses (`38.133 §3.5.2`,
`36.133 §8.20.2.1`, `38.101-1 §6.3.3.6`):

- **Duplicate NOTE lines removed.** A clause's `NOTE N:` prose was rendered
  once in the body and again as the table's note section. The body now drops
  any `NOTE N:` line whose number also appears under a table (matched by
  number, since 3GPP packs all notes into one concatenated cell); notes that
  belong to no table stay.
- **Multi-table layout — table under its title.** Clauses with several tables
  (e.g. 9 in `36.133 §8.20.2.1`) listed all `Table N:` titles at the top and
  all tables at the bottom. Each table now renders directly under its title
  line (used as the caption, which also fixes mangled `a:` captions). Falls
  back to the stacked layout when titles don't map 1:1 to tables.
- **Figures now render on figures-only clauses.** The Figures section was
  nested inside the structured-tables branch, so a clause with figures but no
  tables (`38.101-1 §6.3.3.6`) showed none. Extracted to a shared
  `ClauseFigures` rendered in both branches. Standalone `Figure N:` caption
  lines are also stripped from the body (kept inline "See Figure …" refs).
- **SVG figures scale-match PNGs.** soffice exported each diagram on a full
  US-Letter page, so SVGs floated tiny while sibling PNGs filled the width.
  The figure API now crops the SVG `viewBox` to its drawn content (union of
  LibreOffice `class="BoundingBox"` rects) and drops the page-sized
  width/height — pure serve-time string rewrite, raster images untouched.
- **Transient figure loads no longer vanish.** A figure's `onError` used to
  hide it permanently; it now retries once (cache-buster) before hiding, so a
  momentary blip doesn't drop a figure whose blob is fine.

No schema or corpus change — still `rel17-v5`.

---

## v0.5.0 — 3GPP Spec Workbench: standalone spec search + hybrid retrieval

**Tagged:** 2026-05-31
**Published:** 2026-05-31 — https://github.com/mayhuifu/bugzilla-triage-desktop/releases/tag/v0.5.0 (corpus `rel17-v5`)

### Highlights

Turns the app from an AI-triage tool into an engineer's all-day **workbench**. The headline is a brand-new **3GPP Specs** tab (`/spec`) — standalone spec search that is **NOT gated behind AI triage and needs no LLM**. It runs the local corpus's retrieval entirely offline (no API key, no network), so an engineer can look up clauses by topic, citation, or acronym any time.

- **New "3GPP Specs" workbench page (`/spec`).** A search-first surface: type free text (`BWP switching after handover`), a citation (`TS 38.331 §5.3.5` → direct jump), or an acronym (`HARQ`). Ranked result cards open the existing resizable **SpecDrawer** (tables + inline figures + NOTE formatting from v0.4.x) on click. Deep-linkable: `/spec?q=…` reproduces a search, `/spec?clause=…` opens a clause directly.
- **Header tabs.** A `Triage Queue` ⇄ `3GPP Specs` toggle now lives in the header of every page, so the two halves of the workbench are one click apart.
- **Bundled hybrid embedder (the big retrieval upgrade).** The desktop now ships `bge-small-en-v1.5` (384-dim ONNX, ~22 MB quantised) via `@huggingface/transformers`, registered as the corpus query-time embedder. When the installed corpus was built with the **same** model, retrieval upgrades from keyword-only BM25 to **hybrid** (BM25 ⊕ dense vectors fused by Reciprocal Rank Fusion) — the same path the build-time eval measures. A `Hybrid retrieval` / `Keyword search` badge on the page (and `hybridActive` in `/api/corpus/status`) makes the active mode visible instead of silently degrading.
- **Browse + acronym sidebar.** A left rail lets you browse all 36 curated specs (expand → drill into a spec's leaf clauses, natural-sorted), look up any of the 152 glossary acronyms, and jump back to **recently-viewed** clauses (localStorage).
- **Cross-feature glue.** A **Research in 3GPP** button sits on the ticket detail header and next to **Run AI Triage** — one click opens `/spec` pre-loaded with the ticket's summary. Bridges triage ↔ knowledge lookup without leaving the app, and (being LLM-optional) works with no provider configured.

### Why a corpus rebuild is required

The desktop's bundled embedder and the corpus's build-time vectors **must share an embedding space** for cosine similarity to mean anything. The shipped `rel17-v4` corpus was embedded with `bge-m3` (1024-dim) — too large to bundle (570 MB ONNX). v0.5 bundles `bge-small-en-v1.5` (384-dim) instead, so the corpus must be **re-embedded and republished as `rel17-v5`** with bge-small. Until that lands, the desktop runs correctly on BM25 (the badge shows `Keyword search` and `/api/corpus/status` reports the model mismatch). The default corpus URL is pointed at `rel17-v5`; users on v4/v3/v2/v1 auto-upgrade on next launch.

### Changes

**Retrieval core**

- `lib/corpus/retriever.ts` — new `retrieveByText(query, {limit})` (the raw-query counterpart to `retrieveContextAsync(ticket)`); extracted `tokenizeText` / `buildQueryFromText` so /spec search and triage tokenise identically; `bm25Retrieve` / `hybridRetrieve` now take a `limit`; new `activeRetrieverPath()` exposes the live `none|bm25-v1|bm25-v2|hybrid-rrf` decision; `decidePath()` lazily registers the bundled embedder.
- `lib/corpus/embedder-bge.ts` (new) — `CorpusEmbedder` impl over `@huggingface/transformers`, `modelId="BAAI/bge-small-en-v1.5"`, CLS-pooled + L2-normalised 384-dim output. Loads the model lazily on first `embed()` from a bundled offline dir (`<cwd>/models/…`), falling back to a remote download in dev. Registered via `ensureBgeEmbedderRegistered()` from the node-only retriever (NOT `instrumentation.ts`, which is edge-compiled and can't resolve the native deps).
- `lib/corpus/store.ts` — new read helpers `listSpecs()`, `listSpecClauses(spec)` (natural clause-number sort), `searchAcronyms(query)`.

**API routes**

- `app/api/corpus/search/route.ts` (new) — `GET ?q=&limit=` → citation-jump or free-text hybrid/BM25 results + `retrieverPath`/`hybridActive`.
- `app/api/corpus/toc/route.ts` (new) — spec list, or one spec's clauses.
- `app/api/corpus/acronym/route.ts` (new) — glossary lookup.
- `app/api/corpus/status/route.ts` — now reports `retrieverPath`, `hybridActive`, `embeddingModel` (corpus) and `queryEmbedderModel` (bundled).

**UI**

- `app/spec/page.tsx` (new), `components/spec/{SpecSearchBox,SpecResultList,SpecResultCard,SpecAcronymPane,SpecTocSidebar}.tsx` (new), `components/ui/HeaderNav.tsx` (new) — wired into `app/page.tsx` + `app/tickets/[id]/page.tsx` + `components/triage/TriageChatPanel.tsx`.

**Packaging**

- `next.config.mjs` — externalised `@huggingface/transformers` + `onnxruntime-node`.
- `electron-builder.json` — bundles `models/` + the per-OS ONNX Runtime native libs (the standalone trace grabs only the host platform's shared libs; the explicit per-OS copies guarantee the win/mac/linux binary loads).
- `scripts/fetch-embed-model.mjs` (new) — stages the bge-small ONNX into `models/` before `dist:*` (`npm run fetch:model`). `scripts/spike-embedder.mjs` (new) — Phase-0 embedder smoke test.
- `lib/settings.ts` — `DEFAULT_CORPUS_MANIFEST_URL` → `rel17-v5`; `rel17-v4` added to the legacy auto-upgrade set.

### Maintainer build prerequisites (network-gated — run on a networked machine)

The agent that built this release had no outbound network, so these final steps are **not done yet** and must be run before shipping:

1. **Stage the embedder model** (once, before packaging): `npm run fetch:model` (downloads `bge-small-en-v1.5` into `models/`). Verify with `npm run spike:embedder` → expect a 384-dim, L2≈1.0 vector and `PASS`.
2. **Rebuild the corpus as `rel17-v5`** (corpus repo): merge PR #3 (eval-queries fix) first, then `EMBED_MODEL=BAAI/bge-small-en-v1.5 npm run build` → confirm `meta.embeddingModel=BAAI/bge-small-en-v1.5`, `embeddingDim=384`. Publish: `npm run publish-corpus -- --tag rel17-v5`. Record the eval MRR@10 lift.
3. **Verify the packaged build** on Windows: `npm run dist:win`, install, download the v5 corpus, hit `/api/corpus/status` → expect `hybridActive: true` (NOT a model mismatch), and the `/spec` badge should read `Hybrid retrieval`. This is the load-bearing de-risk (ONNX native-binary packaging) — dev-mode success ≠ packaged success.

Fallback: if the packaged ONNX embedder can't be made to load, v0.5.0 still ships fully functional on **BM25** — the `/spec` UI is identical; only the badge differs.

### Upgrade notes

- **No settings migration.** v0.5 reads the same `settings.json`. The default corpus URL moves to `rel17-v5` and auto-upgrades users on the shipped default.
- **Schema unchanged.** `rel17-v5` stays `schemaVersion=3` (figure images carried forward); only the embedding model changes. `SUPPORTED_SCHEMA_VERSIONS = {1,2,3}` already covers it.
- **Installer size** grows by the ONNX runtime + model (~60 MB win / ~34 MB mac native libs + ~22 MB model). Documented tradeoff for hybrid search.
- **Deferred to a later release:** "Create ticket about this clause" (needs a new-bug form the app doesn't have yet) and the optional "✨ Summarize for this ticket" LLM action (kept out to preserve the page's LLM-optional purity).

---

## v0.4.1 — SpecDrawer polish: resizable width + readable NOTE rows

**Tagged:** —
**Published:** —

### Highlights

Three small but high-value polish fixes to the spec-clause drawer that landed in v0.4.0. All are pure renderer changes — no schema, API, or LLM behaviour change — so this is a clean patch over v0.4.0 and the v4 corpus.

- **Drawer is now user-resizable.** Drag the left edge of the SpecDrawer to widen it for wide tables / large figures, or narrow it to keep more of the underlying triage panel visible. Width persists per-user via localStorage, so the choice survives reloads and re-opens. Min 360 px, max viewport-width minus 80 px gutter, default 672 px (matches v0.4.0's fixed width). A subtle accent stripe appears on hover so the grab zone is discoverable.
- **NOTE rows in clause tables span all columns.** Before: 3GPP NOTE rows like `["NOTE 1: UE that complies…", "", ""]` got their prose crammed into whatever the first column's width was (typically narrow, e.g. for band-name "n95 8"), wrapping at every other word. After: NOTE rows render as a single `<td colSpan={maxCols}>` cell so the prose flows naturally across the full table width. Italic + slightly lighter background distinguishes them from data rows at a glance.
- **Multi-note NOTE cells split per note with hanging indent.** Many spec tables pack multiple notes ("NOTE 1: … NOTE 2: … NOTE 3: …") into a single source cell separated only by spaces. v0.4.1's renderer detects the pattern (case-tolerant `\bNOTE\s+\d+\s*[:.]` lookahead) and breaks each note into its own paragraph with a hanging indent so the `NOTE N:` prefix stays visually anchored when prose wraps. Single-note cells skip the split and just use `whitespace-pre-wrap`, preserving any author-supplied newlines.

### Changes

- `components/triage/SpecDrawer.tsx` — added `width` state with localStorage persistence (`bugzilla-triage:spec-drawer:width`), drag handle on the left edge with cursor + selection lock during drag, window-resize re-clamp.
- `components/triage/SpecDrawer.tsx` → `ClauseTable` — new `isNoteRow()` heuristic + `maxCols` computation, conditional NOTE-row render with `colSpan` and per-note splitting.

### Upgrade notes

- **No corpus or settings change.** v0.4.1 reads the same `rel17-v4` corpus and the same `settings.json` as v0.4.0.
- **First open of a drawer after upgrade** uses the 672 px default. Drag once, your preference is remembered from then on.
- **Header-detection edge case**: a table that happens to start with a NOTE row (uncommon, seen in some amended-spec annex tables) no longer hijacks the note as a column header — `isNoteRow()` is checked before the header heuristic.

---

## v0.4.0 — Inline 3GPP figure rendering + LLM vision over corpus diagrams

**Tagged:** —
**Published:** —

### Highlights

The 3GPP corpus shipped its **rel17-v4** SQLite this week — same 12,930 leaf clauses + structured tables, plus a brand-new `figure_images` table carrying inline SVG/PNG/JPEG bytes of every captioned figure (1,128 images, 66 MB raw / 68 MB gzipped). This release teaches the desktop how to consume it.

- **Spec drawer renders figures inline.** Click `View clause` on any 3GPP citation and the drawer now shows the actual signal-flow diagrams, resource grids, timing pictures alongside the clause text. SVG figures render natively via the browser, sharp at any zoom. PNG/JPEG figures (mostly in 36.300 architecture diagrams + RF test plots) also render inline. The old "Figures referenced" caption-only fallback now only fires for clauses whose figures didn't pair with a media file during parse.
- **LLM vision content blocks for corpus diagrams.** When AI Triage retrieves spec context AND the chosen provider/model supports vision (Anthropic, GPT-4o, Codex CLI, etc.), the retrieved clauses' raster figure images (PNG/JPEG/GIF) are attached to the user message as image content blocks. The model can now actually look at a referenced spec diagram instead of relying on text-only clause-body context. SVG figures are skipped for vision (neither Anthropic nor OpenAI accept SVG natively, and server-side rasterising is a heavier follow-up) — they still render in the drawer. Hard cap at 6 corpus images per triage to keep token cost bounded.
- **Default corpus URL → rel17-v4.** Users who installed the rel17-v3 default (or v1/v2) auto-upgrade silently on next launch. Users with a custom mirror keep their URL untouched.

### Changes

**Corpus client**

- `lib/corpus/manifest.ts` — `SUPPORTED_SCHEMA_VERSIONS` extended to accept v3 corpora alongside v1/v2.
- `lib/corpus/store.ts` — new `corpusHasFigureImages()` (probe-once-per-process), `getFigureImagesForClause(clauseId)` (lightweight metadata-only enumeration), and `getFigureImageBlob(clauseId, figureId)` (single-blob fetch). All three degrade silently to "no images" on v1/v2 corpora.
- `lib/corpus/retriever.ts` — `RetrievedClause` gains a new optional `figureImages` field; `lookupClause()` populates it with `{figureId, mimeType, bytes}` metadata (no blobs inlined; blobs fetched on demand). `ClauseFigure` gains a `mediaFilename` field for the v3 schema. Backward-compatible: v1/v2 corpora return empty `figureImages: []`.
- `lib/settings.ts` — `DEFAULT_CORPUS_MANIFEST_URL` flipped from `rel17-v3` → `rel17-v4`; v3 URL added to `LEGACY_DEFAULT_CORPUS_MANIFEST_URLS` for auto-upgrade.

**Image streaming**

- `app/api/corpus/figure/route.ts` (new) — `GET /api/corpus/figure?clauseId=…&figureId=…` streams the raw blob bytes with the correct Content-Type and a 1-hour private cache (the corpus SQLite is immutable for a given installed version). 404 cleanly on missing.

**UI**

- `components/triage/SpecDrawer.tsx` — replaced the small "Figures referenced" caption list with a proper figure grid. Each figure renders as an `<img>` (when the corpus has an associated blob) with `figcaption` below carrying the figure id + caption. Onload-error fallback hides broken images so a corrupted blob doesn't break the panel layout. Max height capped at 480 px to keep long figure stacks from dominating the drawer.

**LLM vision**

- `lib/llm.ts` — new `loadCorpusFigureImages(retrievedClauses)` walks the retrieved-context array, pulls PNG/JPEG/GIF/WebP blobs out of the corpus, returns them as `InlineImage[]`. SVG and unknown MIME types are skipped (vision endpoints don't accept SVG natively). The result is concatenated with ticket-attachment images and threaded through the existing multimodal content-block plumbing on both the Anthropic and OpenAI-compatible paths. Hard cap at `MAX_CORPUS_FIGURE_IMAGES = 6` per triage.

### Upgrade notes

- **No schema migration.** Existing settings.json files load unchanged; the `LEGACY_DEFAULT_CORPUS_MANIFEST_URLS` set covers all previously-shipped defaults. Users with custom mirrors keep their URL.
- **First launch after upgrade auto-fetches the v4 corpus** (~68 MB gzipped, 226 MB on disk after decompression). The download is gated by the CorpusInstallBanner; users who chose not to install a corpus stay text-only.
- **Vision cost goes up slightly when triaging cellular tickets** because retrieved spec diagrams are now sent to the model. On Anthropic Sonnet this is ~$0.005–0.02 per image × up to 6 images per triage ≈ 1–10 ¢ extra. Set `MAX_CORPUS_FIGURE_IMAGES = 0` in `lib/llm.ts` if you want to suppress entirely.
- **SVG vision is deferred.** Most 3GPP figures are SVG (921 of 1,128) and the LLM doesn't see those today. The SpecDrawer still renders them so a human reviewing the triage can click `View clause` and look at the diagram themselves. Server-side SVG-to-PNG rasterising for vision is a follow-up.

---

## v0.3.0 — Live-Bugzilla assignee search + due-date-driven SLA

**Tagged:** 2026-05-26
**Published:** 2026-05-29 (first CI attempt 2026-05-26 hit a transient GitHub Actions billing glitch that returned an "account suspended" error; rerun on 2026-05-29 cleared cleanly and shipped all three installers)

### Highlights

Two user-facing improvements that target real day-to-day pain points on a busy Bugzilla.

- **Assignee filter → live Bugzilla user search.** The old assignee dropdown only listed engineers whose tickets happened to be in the currently-loaded 25-row page — useless for finding "all tickets owned by Joachim" if his queue isn't in that window. The dashboard now exposes a typeahead control: type ≥ 2 characters, get suggestions from Bugzilla's `/rest/user?match=…` endpoint, click → tickets filter to that assignee's queue across the **entire** Bugzilla (not just the loaded page). Empty + focused still shows the loaded-window assignees as quick presets for one-click filtering on people you're already looking at.
- **Due-date-driven SLA overrides the default heuristic.** Tickets with a Bugzilla `deadline` field set now drive the SLA badge directly: past → **breach**, ≤ 5 days out → **at risk**, > 5 days out → **on track** (overrides the default severity/age rules — a Critical bug 35 days old but with a customer-agreed deadline 2 months out is no longer wrongly flagged as breach). The badge wording changes too — "SLA breach · 22d overdue" / "At risk · due in 3d" / "On track · due in 14d" — and the tooltip spells out which rule fired so the user can audit.

Plus one quality-of-life add:

- **Assignee filter** (the field itself, added before the search upgrade) now appears in saved filters as `@username`, gets included in the dashboard scope label, and is mutually exclusive with "My Tickets" (the toggle wins precedence-wise and greys out the assignee control).

### Changes

**Live-Bugzilla assignee search**

- `lib/bugzilla.ts` — new `findUsers(match, limit)` wraps `/rest/user?match=…`. Returns `{id, name, realName}` per match. `name` is the Bugzilla login (email); `realName` is the display name shown as the primary line in the typeahead. Payload trimmed via `include_fields` so the proxy only forwards what the UI uses.
- `lib/bridge.ts` — new `bridgeFindUsers` pass-through.
- `app/api/users/route.ts` — new proxy endpoint. Short-circuits when `match` < 2 chars (returns `{users: []}`); caps results at 25; degrades gracefully on Bugzilla failures (returns `{users: [], error}` with HTTP 502 instead of a 500 that would crash the typeahead).
- `components/dashboard/AssigneeFilter.tsx` — new ~210-LoC typeahead. Debounced 300 ms, AbortController-cancelled stale responses, ↑/↓/Enter/Esc keyboard nav, outside-click dismissal, empty-state falls back to the loaded-window assignees. Pasted-full-email + Enter accepted verbatim without a round-trip.
- `components/dashboard/TicketFilters.tsx` — replaced the assignee `<select>` with `<AssigneeFilter>`. `state.assignee` (full email) wiring unchanged from the previous step.

**Due-date-driven SLA**

- `lib/types.ts` — `TicketSummary` gains `dueDate?: string` (YYYY-MM-DD).
- `lib/bugzilla.ts` — new helper `daysUntilIso(iso)` (positive future, negative past; treats the date as end-of-day UTC). `computeSla()` rewritten with new precedence: closed → ok → due_date override → default age heuristic. `SUMMARY_FIELDS` includes `deadline`. `normalizeSummary` carries `dueDate` through.
- `components/ui/Badge.tsx` — `SlaIndicator` accepts `dueDate?: string`. When set, the suffix becomes `"Nd overdue"` (breach) / `"due in Nd"` (warn/ok) / `"due today"` (warn at 0 days). Tooltip explains which rule fired.
- `components/dashboard/TicketTable.tsx` + `components/detail/TicketDetailHeader.tsx` — both `<SlaIndicator>` callsites now pass `dueDate={t.dueDate}`.
- `lib/mock-data.ts` — mock `risk()` mirrors the new precedence; demo path stays consistent with live data.

**Assignee filter (prerequisite for the search)**

- `components/dashboard/TicketFilters.tsx` + `FilterState` — added `assignee: string`.
- `app/page.tsx` — `INITIAL_FILTERS` extended; `assigneesFromLoaded` memo computes the typeahead's recent-suggestions list; `serverQuery` sets `?assignee=` from the dropdown when My Tickets is off (precedence: My Tickets > assignee field). Scope label appends `@username`.
- `components/dashboard/SavedFilters.tsx` — `describeFilter` now includes `@username` for saved filters with an assignee set (skipped when My Tickets is on).

### Upgrade notes

- **No schema migration.** `TicketSummary.dueDate` and `FilterState.assignee` are optional / default-empty; the saved-filter localStorage shape is forward-compatible — older entries without these fields load fine.
- **Bugzilla `deadline` field must be set** on a ticket for the override to trigger; tickets without a deadline keep the existing severity/age-based SLA.
- **Closed tickets with a past deadline still show `ok`** — the closed-status check takes precedence over the deadline check, matching "no SLA on closed work". If you want post-mortem SLA reporting (tickets resolved AFTER their deadline flagged for retrospective metrics) that's a separate feature; raise a ticket.
- **Bugzilla user-search permissions vary by install.** The user-search endpoint (`/rest/user`) requires `creategroups` or `editusers` privilege on some Bugzilla deployments, but most installs allow any authenticated user to call it. If you see "Search failed" in the typeahead, your account may lack the permission — check with your Bugzilla admin.

---

## v0.2.0 — Subscription-routed providers, vision + PDF triage, formatting overhaul

**Tagged:** 2026-05-21
**Published:** 2026-05-21

### Highlights

This is the first minor bump since v0.1.0 — it expands the LLM surface in three meaningful ways AND rewrites how AI output reaches Bugzilla.

- **Two new LLM providers route triage through your existing subscription instead of an API key.**
  - **Claude Code CLI** (`claude-cli`) spawns `claude -p` locally; uses the Claude Code subscription via keychain OAuth. Auto-selected when launched inside a Claude Code session (`CLAUDECODE=1`) with no Anthropic API key configured.
  - **OpenAI Codex CLI** (`codex-cli`) spawns `codex exec` locally; uses the ChatGPT subscription. Supports native image attachment via `codex -i` (we save each Bugzilla image to a per-triage tmp dir and pass the path through). PDFs go through text extraction.
- **Image triage (vision) on every provider that supports it.** When a ticket has `image/{png,jpeg,gif,webp}` attachments and the configured provider/model is vision-capable, the bytes are fetched from Bugzilla and inlined as content blocks alongside the user prompt. Anthropic, GPT-4o/Codex CLI, and any `vision`/`vl`-tagged model get them; DeepSeek/text-only models are auto-skipped with no bandwidth waste.
- **PDF triage on every provider.** Anthropic uses native `document` blocks (32 MB/100 pages); everyone else (OpenAI-compatible, Claude CLI, Codex CLI) gets server-side text extraction via `pdfjs-dist` legacy build. Per-PDF/per-triage size caps prevent the 50 KB chart PDF from blowing past the DeepSeek context window.
- **Inline image thumbnails + click-to-zoom lightbox in the ticket detail panel.** A new `/api/tickets/<id>/attachments/<attId>` proxy streams the bytes (5 MB cap, 5-min private cache) — the panel renders an `<img>` thumbnail grid for every image attachment with click-to-expand. Non-image and oversized files keep the existing icon row.
- **Search by ticket ID works across the entire Bugzilla.** Previously the search box only filtered the loaded 25-row page — searching for a ticket number outside that window returned nothing. Now any pure-numeric query debounces 300 ms, fetches `/api/tickets/<id>` directly, and pins the result regardless of the active scope (product/component/status).
- **Bugzilla comment formatting fix.** The umsemi Bugzilla renders markdown but doesn't recognise triple-backtick fenced code blocks — every previous AI comment had its underscores italicized (`harq_gain_param_input` → `harq*gain*param*input`), bullets collapsed into flowing paragraphs, and the CLASSIFICATION header rendered as an H1. The new path 4-space-indents every line of the structured body so it renders as `<pre><code>` in any markdown renderer — bullets, underscores, line breaks, and the `==========` separators all survive.
- **AI brevity directive.** SYSTEM_PROMPT + schema now enforce ≤ 25 words per bullet, ≤ 3 hypotheses, ≤ 4 next-step owners, and 1-sentence (≤ 25 words, ≤ 160 chars) spec-clause summaries. The CLASSIFICATION header no longer dumps the full corpus excerpt — just the clause + a one-line summary. Net effect: typical comment dropped from ~6,900 chars to ~2,800 chars without losing signal.
- **Model badge in the Initial Classification bubble.** Tells you at a glance which model produced a triage (`claude-opus-4-7`, `gpt-5.5`, `deepseek-v4-pro`, etc.) — useful when comparing runs across providers.

### Changes

**New providers**

- `lib/settings.ts` — `LlmProvider` extended to `"anthropic" | "openai-compatible" | "claude-cli" | "codex-cli"`. Env auto-detection: when `CLAUDECODE=1` and no Anthropic key, defaults to `claude-cli`.
- `lib/llm.ts` — new dispatch branches `runTriageClaudeCli` and `runTriageCodexCli`. Each shells out via Node `child_process.spawn`, captures the answer from `-o <file>` (Codex) or `--output-format json` (Claude), parses, runs the same `fillTriageDefaults` + corpus enrichment + classification-header pipeline as the API-key paths. ENOENT → friendly "install + login" error.
- Codex CLI bug fixes: `-i / --image` is variadic in clap (it eats the positional `<prompt>` → codex falls back to stdin → exits 1), so we pass `-` as the prompt sentinel and pipe via `child.stdin`. The ChatGPT subscription rejects uppercased model ids (`'GPT-5.5' not supported` while `gpt-5.5` works), so we lowercase before passing through.
- Claude CLI bug fix: `--bare` flag strips OAuth keychain reads — removed, so subscription auth works.
- `app/settings/page.tsx` — Provider dropdown gains "Claude Code CLI (use my subscription)" and "OpenAI Codex CLI (use my ChatGPT subscription)" entries; hides API URL/key fields when a CLI provider is selected; shows install-instructions card per provider.

**Vision + PDF**

- `lib/llm.ts` — `providerSupportsVision(provider, model)` allowlist (Anthropic + Codex CLI + GPT-4o/o-series + Claude-via-proxy + `*vision*`/`*vl*` patterns; explicit `deepseek-*` → false). `loadImageAttachments(ticket)` fetches via the existing `attachments()` helper (5 MB cap inherited), pre-filters on metadata so tickets without images skip the round-trip.
- `lib/llm.ts` — `loadPdfAttachments(ticket, nativeSupported)` returns either native PDF blobs (Anthropic) or extracted text (everyone else). `extractPdfText` uses pdfjs-dist legacy build with `useSystemFonts: false`, `disableFontFace: true` for hardened parsing of untrusted PDFs. Caps: 5 PDFs / 50 KB text per file / 200 KB total / 100 pages.
- `lib/llm.ts` — Anthropic + OpenAI provider paths build multimodal content arrays when images present; manifest-injection prompt tells the model "quote specific values you can read off the images/PDFs in OBSERVED".
- `package.json` — `pdfjs-dist@^5.7.284` added; `next.config.mjs` adds it to `serverExternalPackages` so it isn't bundled by webpack.
- `app/api/tickets/[id]/attachments/[attachmentId]/route.ts` — new attachment proxy route. Streams base64-decoded bytes from Bugzilla with the correct `Content-Type` + 5-minute private cache.

**UI**

- `components/detail/TicketDescription.tsx` — image attachments render as a 2-4 col thumbnail grid above the existing file list; click opens a full-screen lightbox (ESC + backdrop click + X button all close; download button preserves the original filename via `Content-Disposition`). Oversized images (> 5 MB) fall back to the icon row with "too large to preview" hint.
- `components/detail/TicketComments.tsx` — long comments (> 800 chars) collapse with a "Show full comment (N chars)" toggle; per-comment state keyed by comment id; max panel height bumped 480 → 640 px.
- `app/page.tsx` — direct ticket-ID lookup: numeric search queries debounce 300 ms and fetch `/api/tickets/<id>`, pinning the result at the top of the filtered list with an "(outside current scope)" hint. Includes three UX states: looking up, pinned, not found.
- `components/triage/TriageChatPanel.tsx` — model badge in the Initial Classification bubble next to the confidence + domain chips. Hover shows "Generated by <model> on <timestamp>".

**Comment formatting + brevity**

- `lib/bugzilla.ts` — new `indentAsCodeBlock(text)` helper 4-space-indents every line of the AI-generated body. The `Analyzed by AI Triage Bot:` prefix stays outside the indented block so it renders as a plain paragraph header (no Setext H1 surprise). Also passes `is_markdown: false` as belt-and-suspenders (harmless if the server ignores it).
- `lib/llm.ts` — SYSTEM_PROMPT gains a `BREVITY (load-bearing)` block: ≤ 25 words per bullet, 3-6 OBSERVED, 2-4 INFERRED, ≤ 3 HYPOTHESIS, ≤ 4 NEXT STEPS owners; no padding adverbs; no multi-clause sentences within a bullet. Spec-excerpt summaries capped at ≤ 25 words / 160 chars.
- `lib/llm.ts` — `pickHeaderBody` drops the `[corpus]` / `[ai paraphrase]` tag prefix from the Bugzilla comment body (tag still shown in the on-screen UI card for transparency); uses only `summary`, never realText. `condenseForHeader(text, maxLen)` accepts a length param; CLASSIFICATION header passes 160.

### Upgrade notes

- **No schema migration.** The `Settings` shape gains support for two new `llmProvider` enum values; older saved settings.json files load fine — they keep their existing provider.
- **CLI providers are opt-in.** To switch, open Settings → Provider → "Claude Code CLI" or "OpenAI Codex CLI". The CLI binary must be on PATH and authenticated (`claude` / `codex login` once interactively).
- **Codex CLI: model id case matters.** If you've previously typed an uppercase model id (e.g. `GPT-5.5`), edit it to lowercase or leave it blank to use `~/.codex/config.toml`. The dispatch auto-lowercases on the fly but if you re-save Settings, the field re-stores whatever you typed.
- **DeepSeek users**: no behavioural change. Images skipped (provider doesn't support vision); PDF text extracted into the prompt; comment formatting + brevity improvements apply equally.
- **Anthropic API users**: now get native PDF document blocks. Token cost per triage on tickets with PDFs goes up a bit because PDFs are real content, not metadata. Cap if needed by editing `MAX_PDFS_NATIVE` in `lib/llm.ts`.
- **Bugzilla comment width**: 4-space indentation makes the comment slightly wider in raw form (every line + 4 chars). Most Bugzilla `<pre>` blocks wrap; if yours doesn't, the indented box will horizontal-scroll for very long lines.

---

## v0.1.27 — Dashboard ticket counts no longer saturate at 10,000

**Tagged:** —
**Published:** —

### Highlights

- **Dashboard stats panels (open total / closed total / filed last 7 days / etc.) were silently capping at exactly 10,000.** The hard cap lived in `lib/bugzilla.ts`'s `stats()` function: a single `["limit", "10000"]` parameter on each of 14 `/rest/bug` count queries. Bugzilla's REST API doesn't have a count-only endpoint, so this code asks for IDs only with a large limit — but on Bugzillas with more than 10k bugs in any one bucket the response is truncated and the count clamps. Affected ~every metric on the Triage Queue header for users with a busy Bugzilla.
- **Fix: paginate via `offset` until the API returns a short page.** Page size is still 10,000 (Bugzilla's default `max_search_results`); the loop walks pages 0…N until one comes back with fewer rows than requested. Real ticket totals up to ~500k are now counted accurately (50-page safety cap; warn-and-truncate beyond that).

### Why this hadn't surfaced before

The 10k truncation looks identical to a real total of 10k for any bucket that genuinely has more than 10k bugs. Date-window buckets ("filed last 7d", "closed prev 7d") almost never hit it because 7 days of bugs is usually small. The Open Total bucket on a long-running Bugzilla with many low-severity tickets is the typical canary — that's what the user saw.

### Changes

- `lib/bugzilla.ts` — `countQuery()` rewritten to loop over `offset` pages of 10,000 until a short page terminates the loop. Adds `SAFETY_MAX_PAGES = 50` (= 500k bugs/query) to bound the worst case; logs a warning and returns the truncated total if hit.

### Upgrade notes

- Dashboard load may take **slightly longer** on installations that genuinely have >10k bugs in one bucket (extra round-trip per additional 10k bugs per query × 14 queries running in parallel). On a Bugzilla with 25k open bugs that's ~3 pages × 14 queries = ~42 HTTP calls instead of the previous 14. All still in parallel under `Promise.all`, so wall-clock impact is small (< 1s extra typically).
- No schema or settings change.
- If you see the warning *"countQuery hit SAFETY_MAX_PAGES"* in the standalone server log, raise the constant — but at 500k+ bugs you probably want a different metric strategy anyway.

---

## v0.1.26 — Pin Electron to ^38.0.0 (LTS) so better-sqlite3 actually loads

**Tagged:** —
**Published:** —

### Highlights

- **Electron downgraded from 42.x → 38.x (LTS)** because the better-sqlite3@12.10.0 native binary is the load-bearing dependency and Electron 42's V8 13 isn't compatible.
- v0.1.25 tried to download better-sqlite3's electron-v42 prebuild via `npm_config_runtime=electron` env vars. That prebuild doesn't exist on npm — prebuild-install fell back to compiling from source against Electron 42's headers, which failed with the same `'v8::External::Value': function does not take 0 arguments` error that pushed v0.1.9 to disable rebuilds in the first place.
- **The fix path:** Electron 38 LTS bundles V8 12.x (old `External::Value()` API still present) AND better-sqlite3@12.10.0 publishes an electron-v38 prebuild on npm. The env-var-targeted install in `release.yml` now grabs that prebuild, electron-builder packages it as-is, runtime ABI matches at app launch.
- Electron 38 LTS is the current LTS as of mid-2026; supported through to 2027. Will rev to 39 → 40 → 42 again once better-sqlite3 publishes a fix for V8 13 (issue tracked upstream in WiseLibs/better-sqlite3).

### Changes

- `package.json` — `"electron": "^42.1.0"` → `"^38.0.0"`. Resolves to `38.8.6` via `npm install`.
- `package-lock.json` — refreshed to reflect Electron 38.8.6 and its transitive deps.
- `.github/workflows/release.yml` — `npm_config_target` env on the Install step bumped from `"42.1.0"` to `"38.8.6"`.

### Upgrade notes

- Install v0.1.26 on Windows. The shipped `better_sqlite3.node` finally has the right ABI to load under the desktop's Electron 38 runtime. Hit `/api/corpus/diag` — `engineLoaded` should be `true`, all four lookup probes (including the `38.211 §7.4.2.2` ancestor case) should report `hit: true`, View clause buttons should appear in AI Triage.
- The corpus you already downloaded (rel17-v3) is fine.
- Behaviour parity vs Electron 42: no user-visible changes expected. Electron 38 has the same `BrowserWindow`, `app.getPath`, `process.resourcesPath`, and `ELECTRON_RUN_AS_NODE` semantics we depend on.

---

## v0.1.25 — Download better-sqlite3's Electron-42 prebuild instead of compiling

**Tagged:** 2026-05-20
**Published:** Never — prebuild-install couldn't find an electron-v42 prebuild for better-sqlite3@12.10.0 on npm and fell back to compile, which fails on V8 13. Same fix path shipped as v0.1.26 via Electron downgrade.

**Tagged:** —
**Published:** —

### Highlights

- **The real fix for the NODE_MODULE_VERSION 115 vs 146 ABI mismatch.** v0.1.24's `npmRebuild: true` correctly *tried* to compile better-sqlite3 against Electron 42's headers, but better-sqlite3@12.10.0's C++ source uses zero-arg `v8::External::Value()` which V8 13 (shipped in Electron 42) removed. Build failed identically on Windows, macOS, and Linux:
  ```
  error C2660: 'v8::External::Value': function does not take 0 arguments
  ```
  This is the exact failure v0.1.9 originally worked around by setting `npmRebuild: false`. The escape hatch we need isn't to compile from source — it's to **download a pre-built binary that matches Electron 42's ABI**. better-sqlite3 publishes those on npm.
- **Set `npm_config_runtime=electron` + `npm_config_target=42.1.0` before `npm ci`.** That tells `prebuild-install` (better-sqlite3's postinstall step) to fetch `electron-v42-…tar.gz` from the npm prebuild mirror instead of the default `node-v115-…tar.gz`. The shipped `.node` binary then has NODE_MODULE_VERSION 146 from the start; no rebuild needed.

### Changes

- `.github/workflows/release.yml` — added `env:` block to the "Install dependencies" step:
  ```yaml
  env:
    npm_config_runtime: electron
    npm_config_target: "42.1.0"
    npm_config_disturl: https://electronjs.org/headers
  run: npm ci
  ```
- `electron-builder.json` — `"npmRebuild": false` (reverted from v0.1.24's `true`). Since the prebuild already has the right ABI, no rebuild step is needed; and skipping it avoids the broken-compile path.

### Upgrade notes

- Install v0.1.25 on Windows. The installer now contains a `better_sqlite3.node` matching Electron 42's ABI 146. Hit `/api/corpus/diag` again — `engineLoaded` should flip to `true`, `openError` should be `null`, the schema columns should populate, and all four lookup probes (including the `38.211 §7.4.2.2` ancestor case) should report `hit: true`.
- The corpus file you already downloaded (rel17-v3) is fine — only the engine's ability to *open* it was broken.

---

## v0.1.24 — Same ABI fix as v0.1.23 minus the schema-illegal comment key

**Tagged:** —
**Published:** —

### Highlights

- **v0.1.23 was buildable in theory but unbuildable in practice.** I added an `_npmRebuildHistory` string to `electron-builder.json` to document why `npmRebuild` flipped from false → true. electron-builder 26.8.1 validates the config against a strict JSON schema and rejects unknown properties → CI failed on every OS before even reaching the package step → no installers shipped.
- **v0.1.24 is identical to v0.1.23 minus the comment key.** The original history / rationale lives in this release-notes file (see v0.1.23 below) plus the v0.1.23 commit message. JSON doesn't have comments and the schema doesn't allow extension fields. Lesson: don't try.

### Changes

- `electron-builder.json` — removed the `_npmRebuildHistory` key. `"npmRebuild": true` is preserved.

---

## v0.1.23 — Fix NODE_MODULE_VERSION ABI mismatch — better-sqlite3 now rebuilt against Electron 42

**Tagged:** 2026-05-20  
**Published:** Never — CI build failed schema validation in electron-builder 26.8.1 (`_npmRebuildHistory` was not a recognised property). Same fix shipped as v0.1.24.

**Tagged:** —
**Published:** —

### The actual bug

Diag JSON from a v0.1.22 install on Windows revealed this:

```
The module 'better_sqlite3.node' was compiled against a different Node.js
version using NODE_MODULE_VERSION 115. This version of Node.js requires
NODE_MODULE_VERSION 146.
```

| ABI | Runtime |
|---|---|
| 115 | Node.js 20 (what `actions/setup-node@v4 node-version: "20"` provides during `npm ci`) |
| 146 | **Electron 42** (the runtime that loads the .node file at app launch) |

So `npm ci` on every CI runner has been downloading better-sqlite3's Node-20 prebuild, and `electron-builder.json`'s `"npmRebuild": false` (set in v0.1.9) prevented the rebuild step that would normally swap that out for an Electron-42-targeted binary. Every installer from v0.1.10 onward has shipped a `.node` file Electron 42 can't dlopen. The reason the bug only surfaced now is that v0.1.9 didn't actually need the corpus engine to load — v0.1.10 introduced the corpus retriever, and the lazy-require in v0.1.17 hid the failure further (download succeeded, retrieval silently no-op'd).

### The fix

`electron-builder.json` → `"npmRebuild": true`. electron-builder then runs `@electron/rebuild` (bundled internally) during packaging, which:

1. Calls `prebuild-install --runtime=electron --target=42.x` to fetch the Electron-targeted better-sqlite3 prebuild from npm; or
2. Falls back to compiling against `electron/headers` with VS C++ tools (windows-latest runner has these by default).

Either way the shipped `.node` file's ABI now matches Electron 42's runtime, so `new Database(...)` in `lib/corpus/store.ts` succeeds and `engineLoaded` flips to true. Every downstream feature (corpus banner state, RAG toggle, View clause button, ancestor-prefix lookup, hybrid retrieval scaffolding) starts working without further changes.

### Why this was disabled in v0.1.9 (history)

v0.1.9's release notes documented a one-off failure: older better-sqlite3 + Electron 42 V8 13 headers couldn't compile on macOS (`'Value' declared here` C++ error). The workaround was `npmRebuild: false` — which silently shipped the wrong ABI from then on. better-sqlite3 12.10.0 has since fixed the V8 13 compatibility, so the rebuild should succeed on all three platforms now. If macOS regresses, `fail-fast: false` in the workflow (also added in v0.1.9) means Windows + Linux still ship.

### Changes

- `electron-builder.json` — `"npmRebuild": false` → `"npmRebuild": true`. Plus a `_npmRebuildHistory` key documenting why this is now the value, so future maintainers don't toggle it off without understanding the trade-off.

### Upgrade notes

- **All v0.1.x users:** install v0.1.23, click corpus banner's Download (if rel17-v3 isn't already on disk) — once the engine successfully opens the SQLite, every cited clause that has a corpus match will show the green `[corpus]` chip and a **View clause** button.
- **No corpus re-download is required if you already have rel17-v3 installed.** The corpus file itself is fine; only the app's ability to open it was broken.
- **macOS / Linux installers:** if their CI builds fail because better-sqlite3 can't compile from source, that's a separate fix — but the existing arm64 macOS installer (and ubuntu-latest AppImage) should still build because better-sqlite3 12.10.0 ships prebuilds for `electron-v42-darwin-arm64` and `electron-v42-linux-x64`. We'll know in ~10 minutes.

---

## v0.1.22 — Diag endpoint now reports file-existence and db-open errors

**Tagged:** —
**Published:** —

### Highlights

- **`/api/corpus/diag` now shows why `engineLoaded` is false** when `engineError` is null. Three new fields explain the most common cases:
  - `fileExists` — does `corpus.sqlite` exist on disk at the expected path?
  - `fileSizeBytes` — its size (0 = truncated, ~10–55 MB = healthy)
  - `dirExists` + `dirContents` — what's actually in the corpus directory (handy when the install renamed something)
  - `openError` — the exact error string when `new Database(...)` throws (e.g. SQLITE_NOTADB on a corrupt file, EBUSY on a lock)
  - `fileExistedOnLastOpen` — what the store believed at its last try
- **Reveals install-state bugs that v0.1.20's diag missed.** A user reported `engineLoaded: false, engineError: null` — meaning better-sqlite3 loaded fine, but the engine still returned no DB. v0.1.22's diag will say whether that's "file is missing at expected path" or "file exists but is unreadable", which determines the recovery path (re-download vs. re-install vcredist vs. unlock the file).

### Changes

- `lib/corpus/store.ts` — `getCorpusDb()` now captures the file-existence check and the db-open exception into module-level state. Three new exports: `corpusOpenError()`, `corpusFileExistedOnLastTry()`, `corpusLastTriedPath()`.
- `app/api/corpus/diag/route.ts` — extends the response with `fileExists`, `fileSizeBytes`, `fileMtime`, `dirExists`, `dirContents`, `openError`, `fileExistedOnLastOpen`.

### Upgrade notes

- Purely diagnostic — no behaviour change for working installs.
- After installing v0.1.22, hit `http://localhost:3000/api/corpus/diag` again and the new fields should narrow down whatever's wrong on a broken install in one shot.

---

## v0.1.21 — Default corpus URL → rel17-v3 (adds 38.304 / 38.133 / 36.304 / 36.133)

**Tagged:** —
**Published:** —

### Highlights

- **rel17-v3 is now the default corpus.** The companion repo published [rel17-v3](https://github.com/mayhuifu/bugzilla-triage-corpus/releases/tag/rel17-v3) — adds 38.304 (NR idle-mode RRC procedures), 38.133 (NR RRM requirements), 36.304 (LTE idle mode), and 36.133 (LTE RRM). Citations like `TS 38.304 §5.2.4.5` and `TS 38.133 §4.2` now resolve through to real leaf clauses with "View clause" buttons.
- **Corpus size jumped** from 5,667 → 12,930 leaf clauses, and download grew from ~26 MB to ~55 MB gzipped (~160 MB on disk). 38.133 alone added 3,722 clauses; 36.133 added 3,412. These are the largest cellular specs by clause count, but worth the size because they're cited heavily in idle-mode and RRM triage.
- **Existing rel17-v2 installs auto-upgrade.** If your `settings.json` still has the rel17-v2 default URL (i.e. you accepted the default and never edited it), `loadSettings()` rewrites it to v3 on next launch. The installed corpus file itself stays at v2 until you re-download — open Settings → Spec corpus → "Check for updates" → Install to get v3.

### Changes

- `lib/settings.ts` — `DEFAULT_CORPUS_MANIFEST_URL` switched to `…/rel17-v3/…`. v2 added to `LEGACY_DEFAULT_CORPUS_MANIFEST_URLS` set so existing v2-default installs migrate.
- `components/settings/CorpusSection.tsx` — corpus-blurb stats updated (12,930 / 17,490 / 36 specs / ~55 MB compressed).

### Upgrade notes

- New `.exe` / `.dmg` / `.AppImage` installs: corpus banner offers rel17-v3 (~55 MB).
- Returning v2 installs: URL rewrites silently. To upgrade the installed corpus file, click **"Check for updates"** in Settings → Spec corpus.
- Returning v1 installs (from before v0.1.16): auto-upgrade jumps v1 → v3 directly.
- Custom mirror URLs are untouched.

---

## v0.1.20 — Diagnose missing "View clause" buttons + "spec not in corpus" UI

**Tagged:** —
**Published:** —

### Highlights

- **Self-service diagnostic endpoint** at `/api/corpus/diag`. Returns engine state, schema columns, total clauses, and a live trace of `lookupClause()` against three reference citations (one expected-leaf, two expected-ancestor). Hit it once and the JSON tells us exactly where in the chain (engine load / schema mismatch / SQL miss / parser miss) the bug is.
- **"Spec not in corpus" UI** — when the AI cites a spec we never curated (e.g. `TS 38.304` or `TS 38.133`), the chip now reads `[not in corpus]` in amber instead of the generic `[ai paraphrase]` in gray. A small italic line under the citation says *"This spec isn't in the curated 3GPP corpus — model paraphrase only."* So users understand it's a coverage gap, not a broken lookup.
- **Three corpus-state caches removed.** `corpusHasV2Columns()` and `corpusHasSpec()` previously cached at module scope, which meant an in-process upgrade from v1 to v2 (or v2 to v3) read the OLD schema state forever. PRAGMA table_info is microsecond-cheap; just re-check.

### Changes

- `app/api/corpus/diag/route.ts` (new) — JSON dump of engine status, schema columns, total rows, sample SQL probes, and live `lookupClause` traces for known-leaf and known-non-leaf references. Surfaces exactly what's broken on a specific install. Use `Ctrl+Shift+I` → paste the URL `http://localhost:3000/api/corpus/diag` in the network tab and copy the response.
- `lib/corpus/retriever.ts` — dropped the `_v2ColsChecked` / `_v2ColsPresent` cache and the `_specPresenceCache` Map. Both rechecked per call; cheap.
- `lib/types.ts` — `SpecExcerpt.lookupReason: "spec_not_curated" | "clause_not_found" | "no_corpus"`. Optional, defaults missing.
- `lib/llm.ts` — `enrichExcerptsWithCorpus()` now sets `lookupReason` on every model-only excerpt by checking whether the cited spec is even in the corpus, via `corpusHasSpec()`. Also synthesises a bare excerpt for any `specReferences` entry that didn't come with a model summary, so the UI can always render the citation + reason.
- `components/triage/TriageChatPanel.tsx` — chip text + colour + tooltip now reflect `lookupReason`. Adds an italic explanatory line under model-only citations.

### Upgrade notes

- Purely additive on the API side (`/api/corpus/diag` is a new GET endpoint).
- The `[not in corpus]` chip only appears when the model cites a spec outside the curated set — for most cellular tickets you won't see it at all.
- The cache removal is a behaviour fix; nothing changes for users running a stable v2 corpus.

---

## v0.1.19 — Surface "engine unavailable" warning inside the triage panel

**Tagged:** —
**Published:** —

### Highlights

- **Engine-broken diagnostic now appears next to the "Use 3GPP Spec RAG" toggle** when the user enables RAG inside the triage panel. Previously v0.1.18 surfaced this state only on the home-page banner — users who jumped straight from the queue to a ticket and ran triage saw the RAG toggle, enabled it, and watched every citation come back as `[ai paraphrase]` with no "View clause" button, no idea why. The toggle stays visible (the corpus file IS installed) but a small amber notice underneath explains "Corpus engine unavailable — RAG queries will return no results" plus a link to the VC++ Redistributable.

### Changes

- `components/triage/TriageChatPanel.tsx` — fetches and tracks `engineError` from `/api/corpus/status` alongside `installed`. When RAG is enabled AND engineError is set, renders a compact inline warning under the toggle with the same VC++ Redistributable download link as the home-page banner.

### Upgrade notes

- Purely UI / diagnostic. If your `better-sqlite3` is loading fine, you'll never see this warning.
- If you're hitting "RAG enabled but only `[ai paraphrase]` citations": that's the engine-broken state. Install Visual C++ Redistributable (x64) from Microsoft and restart the app.

---

## v0.1.18 — Surface "installed but engine broken" state + Windows VC++ recovery hint

**Tagged:** —
**Published:** —

### Highlights

- **The Settings card and the AI Triage RAG toggle now correctly recognise a downloaded corpus** even when `better-sqlite3` fails to open it. v0.1.17 lazy-required the native binary so the download path stayed alive, but `/api/corpus/status` was still gating `installed` on the database opening successfully — so after the download finished, the UI silently reverted to the "Download corpus" state and the RAG toggle disappeared. This release decouples the two states.
- **Banner replaces the "Download" CTA with a clear, persistent diagnostic** when the corpus file is on disk but the engine can't load it. Shows the underlying error verbatim plus a one-click link to the Microsoft VC++ Redistributable installer (the fix in 95%+ of Windows cases).

### Why the engine fails on some Windows installs

`better-sqlite3` is a native Node addon — a `.node` file that depends on the Visual C++ runtime DLLs (`vcruntime140.dll` etc.). Fresh / minimal / disk-image-restored Windows installs often don't have those system DLLs, and `LoadLibrary` fails with errors like "The specified module could not be found." Installing the [Visual C++ Redistributable (x64)](https://aka.ms/vs/17/release/vc_redist.x64.exe) from Microsoft and restarting the app fixes it. Antivirus quarantining the `.node` file is the second-most-common cause.

### Changes

- `app/api/corpus/status/route.ts` — `installed` now reflects manifest presence only, not whether the engine successfully opened the DB. New `engineError: string | null` field exposes the underlying `better-sqlite3` load failure (sourced from v0.1.17's `corpusEngineError()`).
- `components/corpus/CorpusInstallBanner.tsx` — new "installed but engine broken" rendering branch with the actual error text, a link to the VC++ Redistributable installer, and a hint about Defender quarantine. Non-dismissible because triage retrieval can't work until the engine loads.

### Upgrade notes

- Purely additive. No settings or data migration.
- If your previous install of v0.1.17 showed an HTTP 500 then completed the download silently with no installed state: install v0.1.18 over it. The banner will now show the actual engine error and the fix link. Most users will: install the VC++ Redistributable, restart the app, see the corpus install as expected.

---

## v0.1.17 — Lazy-require better-sqlite3 so corpus download survives a broken native binary

**Tagged:** —
**Published:** —

### Highlights

- **The corpus-download endpoint no longer crashes when `better-sqlite3` can't load.** v0.1.10–v0.1.16's `lib/corpus/store.ts` had `import Database from "better-sqlite3"` as a top-level ES import. On a Windows install where the native `.node` binary fails to load — wrong arch prebuild, missing VC++ runtime DLL, AV quarantine, etc. — that top-level import throws **before any route handler in the corpus chain can run**. Next.js then returns an opaque 500 with no body (route module failed to load), and even v0.1.15's try/catch wrapper inside `POST /api/corpus/download` never gets a chance to catch it. The banner shows the literal `HTTP 500`.
- **Lazy-require fixes that:** `better-sqlite3` is now `require()`'d inside `getCorpusDb()` the first time the database is opened. If the native binary fails, `getCorpusDb()` records the error and returns `null` — exactly the same shape as "corpus not installed yet". Routes that don't need the DB (download, manifest fetch) keep working. Routes that do (lookup, retrieveContext) silently no-op and the triage UI falls back to model paraphrase.
- **Banner now surfaces response body text** even when the response isn't JSON. So if Next.js's default 500 HTML page is what comes back, the banner shows the first 300 chars of it instead of the bare status code — usable as diagnostic.
- **New `corpusEngineError()` helper** that `lib/corpus/store.ts` exposes for downstream UI surfacing of "native sqlite engine unavailable" as a distinct state from "corpus file missing".

### Why this matters now

The user reported HTTP 500 from the corpus download on a fresh Windows install of v0.1.14/15/16. The diagnostic wrapper from v0.1.15 didn't help — strongly suggesting the failure is at module-load, before the wrapper runs. v0.1.17 turns that failure mode into "download succeeds; retrieval gracefully degrades to model-only triage", which is a much better degradation curve than "feature completely unusable."

### Changes

- `lib/corpus/store.ts` — top-level `import Database from "better-sqlite3"` replaced with a `type`-only import + lazy `require` inside `loadBetterSqlite3()`. New `corpusEngineError()` exported. `getCorpusDb()` returns `null` when the engine couldn't be loaded.
- `components/corpus/CorpusInstallBanner.tsx` — error handler now reads response body as text, attempts JSON parse, falls back to first 300 chars of the raw body. The literal `HTTP 500` only appears when the response body is genuinely empty.

### Upgrade notes

- Purely defensive. If `better-sqlite3` loaded fine on your machine before, nothing changes — the lazy require resolves the same constructor and the DB opens the same way.
- If you were seeing `HTTP 500` before, reinstall v0.1.17. Either the download will now succeed (revealing whether better-sqlite3 was the underlying problem), or the banner will print a longer error message that tells us where to look next.

---

## v0.1.16 — Default corpus URL now points at rel17-v2 (with auto-upgrade for legacy installs)

**Tagged:** —
**Published:** —

### Highlights

- **rel17-v2 is now the default corpus.** The companion repo [bugzilla-triage-corpus](https://github.com/mayhuifu/bugzilla-triage-corpus) just published [rel17-v2](https://github.com/mayhuifu/bugzilla-triage-corpus/releases/tag/rel17-v2) — 5,667 leaf clauses + 9,920 structured tables + 1,092 figure refs + sqlite-vec dense vectors (bge-m3), schemaVersion=2 in the SQLite. The desktop's default manifest URL now points there, so first-launch installs of v0.1.16 will offer this corpus.
- **Existing installs auto-upgrade silently.** If a returning user's `settings.json` still has the previously-shipped rel17-v1 default URL (i.e. they accepted the default and never edited it), `loadSettings()` rewrites it to the rel17-v2 default on next launch. Users who customised the URL to a SharePoint mirror or other internal source are untouched.

### Changes

- `lib/settings.ts` — `DEFAULT_CORPUS_MANIFEST_URL` switched to `…/rel17-v2/…`. New `LEGACY_DEFAULT_CORPUS_MANIFEST_URLS` set lists previously-shipped defaults; if `loadSettings()` finds an exact match in there, it rewrites the value before returning. Migration is in-memory only — `saveSettings()` next persists the new URL.
- `components/settings/CorpusSection.tsx` — corpus-status blurb updated from "5,631 clauses · ~40 MB" to reflect v2's "5,667 leaf clauses + 9,920 tables · ~80 MB, ~26 MB compressed download".

### Upgrade notes

- New `.exe` / `.dmg` / `.AppImage` installs: corpus banner offers rel17-v2 (~26 MB gzipped).
- Existing installs with the rel17-v1 default still saved: the URL rewrites silently, but the *installed* corpus is still v1 until you re-download — open Settings → Spec corpus → click **Check for updates** (or use the banner if it reappears) → install v2.
- Installs with a customised manifest URL (internal mirror): no change. To opt into v2 manually, edit the Manifest URL field in Settings to the rel17-v2 manifest URL on your mirror.

---

## v0.1.15 — Surface the real corpus-download error instead of an opaque HTTP 500

**Tagged:** —
**Published:** —

### Highlights

- **POST /api/corpus/download now returns a readable error message on any unexpected failure.** v0.1.14's banner UI showed `HTTP 500` when the download route threw an unhandled exception (settings read, manifest validation, fs operations, …), giving the user nothing to act on. This release wraps the entire handler in a top-level try/catch and returns `{ error: "download init failed: <name>: <message> [<code>]" }` so the banner can display the actual reason.
- The corpus itself is reachable — `rel17-v1` manifest + artifact return 200 OK from GitHub Releases. Whatever was throwing on the user's Windows machine is now visible.

### Changes

- `app/api/corpus/download/route.ts` — wrapped the POST handler in a top-level try/catch that captures Error name + message + code (when present) and returns it as JSON. Also defensively wrapped the post-download `saveSettings()` call so a settings-write failure can't mask a successful corpus install (the manifest sidecar already records the version).

### Upgrade notes

- Purely diagnostic. If the download was already working for you, nothing changes.
- When upgrading from v0.1.14 with a previously-failed download: clear `localStorage["corpusBannerDismissed"]` in the Electron DevTools console if you want the banner to re-show (or just open Settings → Spec corpus → Download).

---

## v0.1.14 — First-launch banner to install the optional 3GPP corpus

**Tagged:** —
**Published:** —

### Highlights

- **Corpus is now discoverable on first launch.** New users installing the released `.exe` / `.dmg` / `.AppImage` previously had no nudge to download the optional 3GPP RAG corpus — the only way in was Settings → Spec corpus, which most never opened. They'd run AI triage on the BM25-less fallback path forever without realising they were missing the corpus-backed real-spec-text feature. v0.1.14 surfaces a one-time banner on the home page (Triage Queue) with a single **Download corpus** CTA. Dismissible if the user really doesn't want it; auto-hides once installed; shows live progress while downloading.
- **Same install pipeline, different entry point.** The banner reuses the existing `/api/corpus/download` endpoint and respects the configured `corpusManifestUrl` (so China-blocked-GitHub users still get their SharePoint mirror once they've set it under Settings). No NSIS / installer scripting needed — the corpus stays a runtime download, which keeps the installer small and works the same on every OS.

### Why this matters

Without the corpus, AI triage falls back to the model's training-data paraphrase of spec sections. With the corpus, triage cites *real* clause text from Rel-17 NR + LTE with proper §-anchored references. The lift is significant on protocol-heavy tickets (RACH, BWP switching, RRC reconfiguration, RF testing). The corpus is ~10 MB gzipped → ~40 MB on disk; one-time download.

### Changes

- `components/corpus/CorpusInstallBanner.tsx` (new) — top-of-page banner that polls `/api/corpus/status`, shows a CTA when the corpus is missing and not dismissed, switches to a progress bar while downloading, and hides itself once installed. Dismissal is persisted via `localStorage["corpusBannerDismissed"]` (clear it to re-show the banner).
- `app/page.tsx` — mounts the banner above the Triage Queue header.

### Upgrade notes

- Purely additive. Users with the corpus already installed will never see the banner. Users who dismissed it via "Maybe later" can still install via Settings → Spec corpus.
- For users on a GitHub-blocked network: open Settings → Spec corpus → set the Manifest URL to your SharePoint mirror's manifest.json *before* clicking the banner's Download button — the banner uses whatever's configured at click time.

---

## v0.1.13 — Restore "View clause" button when model cites a non-leaf section

**Tagged:** —
**Published:** —

### Highlights

- **"View clause" button reappears for section-level citations.** Models tend to cite at section granularity (e.g. `TS 38.331 §5.3.5`), but the corpus only stores leaf clauses (`5.3.5.1`, `5.3.5.2`, …). v0.1.10–v0.1.12 silently dropped those references because `lookupClause` returns null on a non-leaf id — and no `clauseId` means the Initial Classification bubble doesn't show the "View clause" button at all. v0.1.13 adds an ancestor-prefix fallback: if the exact id misses, look for the lexically smallest leaf under the cited prefix and return that. The button comes back; the drawer shows real content.
- **Ancestor-match hint in the drawer.** When the lookup falls back to a descendant, the drawer shows an amber notice: *"The cited reference TS 38.331 §5.3.5 is a parent section. Showing its first leaf clause TS 38.331 §5.3.5.1."* — so users can see exactly which clause is being displayed and why it differs from the cited reference.

### Changes

- `lib/corpus/retriever.ts` — `lookupClause()` gains a `LIKE '<id>.%'` ancestor fallback after the exact PK miss, ordered by id, limit 1. Returns the leaf with new `matchedAs: "exact" | "ancestor"` and `requestedClauseId` fields so the UI knows whether to show the hint.
- `components/triage/SpecDrawer.tsx` — renders the ancestor-match hint banner above the clause body when `matchedAs === "ancestor"`.

### Upgrade notes

- Purely additive on the corpus side (no schema bump). The fields `matchedAs` / `requestedClauseId` default to `"exact"` / `undefined` for direct hits so no caller breaks.
- The fallback is conservative: it only triggers when there's no exact match, and only walks one level of LIKE matching. Cross-spec / cross-section guesses are not attempted.

---

## v0.1.12 — CI release fix: route artifacts straight to the Release, skip workflow-artifact upload on tag pushes

**Tagged:** —
**Published:** —

### Highlights

- **Re-ship of v0.1.10 + v0.1.11 with the CI release flow fixed.** v0.1.10 and v0.1.11 builds both succeeded on every matrix runner (Windows / macOS / Linux), but the `actions/upload-artifact` step that runs *before* the `softprops/action-gh-release` step failed with `Failed to CreateArtifact: Artifact storage quota has been hit`. Because that step had `if-no-files-found: error`, it failed the whole job, which prevented `Attach to release` from running — so neither version produced an installer on the GitHub Release page.
- Same code as v0.1.11. If v0.1.11 had shipped successfully it would be functionally identical; v0.1.12 just brings the artifacts.

### Changes

- `.github/workflows/release.yml` — reordered + conditionalised the post-build steps:
  - `Attach to release` now runs **first** on tag pushes (`if: always() && startsWith(...)`) so the .exe/.dmg/.AppImage land on the GitHub Release via the REST API, which doesn't touch the Actions artifact-storage quota.
  - `Upload installer` is now scoped to `workflow_dispatch` only — workflow-artifact storage is only useful for dry-runs, never for tag releases (where the Release page is the canonical source).

### Upgrade notes

- Purely build-pipeline. No code or behaviour change vs v0.1.11 from a user perspective.
- Future tag pushes are no longer blocked by Actions storage quota for this repo. If quota is restored later, dispatch-mode dry-runs will start producing workflow artifacts again automatically.

---

## v0.1.11 — Package sqlite-vec native binaries in the installer

**Tagged:** —
**Published:** —

### Highlights

- **Windows / Mac / Linux installers now ship the `vec0` native binary.** v0.1.10 added the `sqlite-vec` dependency but `electron-builder.json` didn't list it under `extraResources`, so the installer's standalone Next.js bundle was missing both the JS loader and the per-platform `.dll`/`.dylib`/`.so`. Runtime fallback in `store.ts` (added in v0.1.10) covers this gracefully — the retriever just stays on BM25-only — but to unlock hybrid retrieval later we need the binary actually packaged. v0.1.11 fixes the packaging.
- No code changes vs v0.1.10. If you already updated to v0.1.10, this release is only meaningful when an embedder gets registered (future PR); update at your convenience.

### Changes

- `electron-builder.json` — added `node_modules/sqlite-vec` to the top-level `extraResources` (JS loader, all platforms). Added platform-specific `extraResources` under each of `win` / `mac` / `linux` for the matching `sqlite-vec-<plat>-<arch>` binary subpackage. The store.ts cwd-based path resolution from v0.1.10 lines up with the in-installer copy location (`<resources>/app/.next/standalone/node_modules/sqlite-vec-<plat>-<arch>/vec0.<ext>`).

### Upgrade notes

- Purely additive. Existing v0.1.10 behaviour is unchanged.
- Cross-OS builds (e.g. `dist:win` on a Mac) will fail to find `node_modules/sqlite-vec-windows-x64` because npm's `optionalDependencies` only install the host-matching subpackage. Build each installer on its target OS, or use the `release.yml` CI workflow which runs `dist:<os>` on the matching matrix runner.

---

## v0.1.10 — Corpus v2 support + Initial Classification UX (short summary, real tables in drawer)

**Tagged:** —
**Published:** —

### Highlights

- **Corpus v2 support.** Reads the upcoming `rel17-v2` corpus that ships sqlite-vec dense vectors, a wider FTS5 index (parent_title + path), an acronyms table, and `meta.schemaVersion=2`. Stays fully backward-compatible with installed v1 corpora — schemaVersion is detected at open time and the retriever picks `bm25-v1` / `bm25-v2` / `hybrid-rrf` accordingly. Full hybrid retrieval lights up automatically once a query-time embedder is registered via `setCorpusEmbedder()` (bundling the embedder ONNX is a separate follow-up).
- **Initial Classification panel: short summary in main view, full clause in the drawer.** Previously the editable textarea under each corpus-matched spec reference was pre-filled with the full clause text — often hundreds of lines. Now it shows a ~280-char auto-condensed summary (sentence-aware). The full corpus text remains a click away via **View clause** → SpecDrawer. Edits in the main textarea write to `summary`, which is what the comment header builder now prefers — so what you see is what gets posted to Bugzilla.
- **Real HTML tables in the drawer.** Clauses with tables used to render as walls of `| pipe | rows |` in a `<pre>`. Now the drawer reads the v2 corpus's structured `tables_json` and renders proper `<table>` elements (with header-row heuristic, striped rows, horizontal scroll for wide tables). v1 corpora fall back to a heuristic pipe-row parser. Figure references are listed below the clause body when present.
- **Acronym-expanded queries.** On v2 corpora, the retriever expands common 3GPP acronyms (PUSCH ↔ Physical Uplink Control Channel, BWP ↔ Bandwidth Part, etc.) from the corpus's `acronyms` table before BM25 — so a bug text using only the abbreviation still finds clauses that spell it out.
- **Sister-repo release**: corresponds to [bugzilla-triage-corpus PR #1](https://github.com/mayhuifu/bugzilla-triage-corpus/pull/1) shipping the v2 corpus build pipeline. This desktop release lands first so the v2 corpus has a consumer ready when it publishes.

### Changes

- `package.json` — added `sqlite-vec` dependency (optional native loader; falls back gracefully on hosts where the per-platform binary isn't available).
- `lib/corpus/manifest.ts` — accept `schemaVersion ∈ {1, 2}` (previously hard-coded `1`).
- `lib/corpus/store.ts` — best-effort load of the `sqlite-vec` extension on db open. Detects whether the open corpus actually carries a `clauses_vec` table. New `corpusHasVectors()` helper. Webpack-safe binary resolution via a `process.cwd()/node_modules/sqlite-vec-<plat>-<arch>/vec0.<ext>` fallback so Next.js bundling can't break the load.
- `lib/corpus/acronyms.ts` (new) — lazily reads the acronyms table; `expandAcronyms()` appends expansion-tokens to a tokenised bug-text query.
- `lib/corpus/embedder.ts` (new) — pluggable `CorpusEmbedder` interface plus `setCorpusEmbedder()` for late-binding a runtime embedder. Stub returns null in this release; bundling the actual ONNX is a follow-up.
- `lib/corpus/retriever.ts` — `decidePath()` picks `bm25-v1` (v1 corpus) / `bm25-v2` (v2 corpus, BM25 over wider FTS5 + acronym expansion) / `hybrid-rrf` (v2 corpus + embedder registered + model match). New `retrieveContextAsync()` exposes the hybrid path; sync `retrieveContext()` kept for back-compat and always uses BM25. `lookupClause()` now surfaces `tables[]` + `figures[]` from `tables_json` / `figures_json` on v2 corpora.
- `app/api/tickets/[id]/triage/route.ts` + `…/followup/route.ts` — switch to `await retrieveContextAsync(ticket)` so hybrid activates the moment an embedder lands.
- `lib/llm.ts` — `enrichExcerptsWithCorpus()` auto-condenses corpus `realText` into a short `summary` (~280 chars, sentence-aware) when the model didn't supply one. `pickHeaderBody()` inverted to prefer the user-editable `summary` over the full `realText`. `realText` stays intact in the excerpt as the source of truth for the drawer.
- `components/triage/TriageChatPanel.tsx` — Initial Classification textarea binds to `summary` (always); edits target `summary` not `realText`; reduced from 4 rows to 2.
- `components/triage/SpecDrawer.tsx` — renders v2 structured tables as real `<table>`s (header heuristic, striped rows, horizontal-scroll overflow). Pipe-row leftovers stripped from the flattened text when structured tables are present. v1 fallback parses pipe-rows heuristically. Figure references listed under the body.

### Upgrade notes

- Purely additive — existing v1 corpora work unchanged on the v1 retrieval path. No settings.json schema bump.
- The new `sqlite-vec` dep is optional at runtime: if its per-platform binary isn't installed the retriever logs `[corpus] sqlite-vec not loaded` once and continues with BM25-only. `electron-builder` packages whatever native binaries are in `node_modules` at build time.
- The full ~25-point hybrid-retrieval precision lift (per Telco-DPR / TelcoAI benchmarks) is dormant in this release because no query-time embedder is bundled yet — only the wider FTS5 index + acronym expansion contribute to v2's precision over v1. Bundling the embedder is a separate follow-up PR.

---

## v0.1.9 — v0.1.8 features + CI fix (better-sqlite3 native rebuild)

**Tagged:** 2026-05-17  
**Published:** —

### Highlights

Same user-facing changes as v0.1.8 (see below — RAG opt-in toggle, retrieval transparency, prompt fix that restored model citations, neutral branding). v0.1.8's CI failed to produce installers because `@electron/rebuild` tried to compile `better-sqlite3@12.x` from source against Electron 42's V8 13 headers — the macOS native rebuild fails with `'Value' declared here` errors (V8 dropped the zero-arg `External::Value()` signature in favor of `Value(tag)`). The same failure quietly broke v0.1.6 and v0.1.7's CI too — none of those tags ever shipped artifacts.

### CI / build changes

- `electron-builder.json` — added `"npmRebuild": false`. The prebuilt N-API binary fetched by `npm install` is ABI-stable across Node and Electron runtimes; we don't need to (and can't, on current Electron) rebuild from source. Local builds and CI both rely on this prebuild now.
- `electron-builder.json` — Mac target arch list is `["arm64"]` only (was `["arm64", "x64"]`). With `npmRebuild: false`, electron-builder packages whatever native binary is in `node_modules` — that's the host arch's prebuild, which is `darwin-arm64` on the CI's `macos-latest` runner. **Intel Mac installer is dropped for v0.1.9** — re-fetch instructions for an x64 binary will return in a later release.
- `.github/workflows/release.yml` — `strategy.fail-fast: false`. Previously one platform's failure cancelled the others; now Windows / Linux / Mac builds are independent, so a single-platform regression doesn't block the rest.

### Upgrade notes

- **Intel Mac users:** v0.1.8 was unbuildable, so the last working Intel Mac installer is **v0.1.4**. v0.1.9 ships arm64 only; Intel support will return after we figure out cross-arch native-binary fetching in CI.
- v0.1.8 tag remains in git history but its CI never produced installers — treat it as a broken intermediate.

### Everything below this section was originally drafted for v0.1.8 — same behavior changes apply

## v0.1.8 — Triage UX polish + RAG opt-in & transparency

**Tagged:** 2026-05-17  
**Published:** Never — CI failure (better-sqlite3 native rebuild against Electron 42 V8 13 headers). Features rolled forward into v0.1.9.

### Highlights

- **3GPP RAG is now opt-in.** The corpus retrieval that v0.1.6 introduced defaulted to ON when the corpus was installed, which surfaced tangential clauses on tickets that weren't cellular-protocol bugs. Now there's an explicit **"Use 3GPP Spec RAG"** checkbox under the **Run AI Triage** button — defaults **off** on first use, persists per-user via `localStorage`.
- **Retrieval transparency.** When RAG runs, a new **"Corpus retrieval"** bubble appears in the chat right after the classification, listing every candidate clause BM25 surfaced with a green `cited` chip or gray `skip` chip based on whether the model picked it. Makes it obvious why the model cited (or didn't cite) specific clauses.
- **Fixed: empty `specReferences` when RAG was on.** v0.1.6/v0.1.7's prompt framed retrieved clauses as "CANDIDATE references — cite ONLY when genuinely relevant", which DeepSeek interpreted as a hard whitelist. On non-cellular-PHY tickets where BM25 returned tangential clauses, the model would emit `specReferences: []` — losing the training-data citations it would have produced without RAG. New prompt explicitly invites citing training-data clauses too, with a worked example.
- **Tighter retrieval.** Top-K reduced from 6 to 4 candidates, so even when RAG is enabled the model sees fewer false-positive citations.
- **Neutral branding.** The small label above each AI bubble used to read **`CLAUDE · AI TRIAGE`** — now reads **`AI TRIAGE`**. The bulk-triage subtitle's "your Claude Code subscription" was also stale (the app supports DeepSeek / OpenAI-compatible now) — updated to "your configured LLM provider".

### Changes

- `lib/llm.ts` — prompt section that injects retrieved clauses rewritten. Old framing was "cite ONLY when relevant"; new framing is "treat as ADDITIONAL evidence alongside training-data knowledge — feel free to cite OTHER clauses when retrieved set doesn't fit". Plus `TriageOptions.enrichWithCorpus?: boolean` (default true) gates `enrichExcerptsWithCorpus()` in both provider paths.
- `lib/corpus/retriever.ts` — `TOP_K`: 6 → 4 (precision over recall).
- `app/api/tickets/[id]/triage/route.ts` + `/followup` — read `?rag=` query param (server default still ON when absent so curl users keep v0.1.7 behavior). Response gains `ragEnabled` + `retrievedClauses: [{citation, title, parentTitle}]` (titles only, no full text) for UI transparency.
- `components/triage/TriageChatPanel.tsx` — new `useRag` state + checkbox under Run AI Triage. Persisted to `localStorage["bugzilla-triage-use-rag"]`, defaults off. New `retrieval-info` chat turn rendered after `ai-classification` when RAG was enabled — shows candidate clauses with `cited`/`skip` chips and a subtitle summarizing what the model picked.
- `components/triage/ChatBubble.tsx` — author label `"Claude · AI Triage"` → `"AI Triage"`.
- `app/bulk-triage/page.tsx` — subtitle says "via your configured LLM provider" instead of "via your Claude Code subscription".
- `RELEASES.md` (new file) — canonical changelog at repo root with backfilled entries for v0.1.1–v0.1.7 and a template at the bottom for future releases.
- `CLAUDE.md` — added "Release notes" subsection pointing at RELEASES.md and stating the rule: notes land there before the tag is cut, in the same commit as the version bump.

### Upgrade notes

- Existing users who had previously toggled the RAG checkbox during v0.1.7 testing will keep their cached value (`localStorage["bugzilla-triage-use-rag"]`). Users on a fresh install or who never clicked the toggle will see it default to **off**.
- API contract: when no `?rag=` is passed, the server still enables RAG (preserves v0.1.7 default). The UI explicitly sends `?rag=0` when the toggle is off.
- This is the **first release with `RELEASES.md`** as the canonical changelog. All future releases append their entry there before the tag is cut.

---

## v0.1.7 — 3GPP RAG UI: SpecDrawer + Settings corpus section

**Tagged:** 2026-05-17 (commit `7a2d9d5`)  
**Published:** Pending (CI run `25981322792` produced the draft release; notes hadn't been written)

### Highlights

Adds the user-facing layer for the M2 backend. v0.1.6 made RAG work end-to-end, but corpus management was API-only and there was no way to view a full clause without copy-pasting the citation into a separate browser tab.

- **Settings → 3GPP spec corpus.** A new card between AI Triage and Appearance. Shows install state + version chip + clause count + size; offers **Download** / **Check for updates** with live progress polling. The **Manifest URL is editable** so China-blocked-GitHub users can paste an internal SharePoint mirror URL and trigger a download against it before saving.
- **SpecDrawer overlay.** Right-side slide-in panel opened from any spec reference in the triage panel. Lazily fetches the full clause via `GET /api/corpus/lookup`; renders citation + parent breadcrumb + preformatted clause text. Buttons: Copy to clipboard, Open spec on 3GPP.org. Escape/backdrop-click close; focus-trapped.
- **Per-clause source tags.** Each spec reference in the "Initial classification" bubble now wears a `[corpus]` / `[corpus+model]` / `[ai paraphrase]` badge so the engineer knows at a glance whether they're reading real spec text or a model summary.

### Changes

- New `components/triage/SpecDrawer.tsx` — overlay + fetch + a11y (escape, focus trap, body-scroll lock).
- New `components/settings/CorpusSection.tsx` — status + download + progress bar + URL override.
- `components/triage/TriageChatPanel.tsx` — mounts SpecDrawer at panel root; per-clause source tag + View clause button in `ai-classification` turn; editable textarea now prefers `realText` when corpus matched.
- `app/settings/page.tsx` — corpus manifest URL form state, mounts `<CorpusSection />`.
- `README.md` / `CLAUDE.md` — corpus dependency documented, China mirror guidance.

### Upgrade notes

- No schema or data changes from v0.1.6. UI-only.

---

## v0.1.6 — 3GPP RAG: real spec text in AI triage

**Tagged:** 2026-05-17 (commit `f937323`)  
**Published:** Pending (CI run `25981122247` produced the draft release; notes hadn't been written)

### Highlights

Replaces the model's training-data paraphrase of cited 3GPP clauses with the actual clause text from a Release-17 NR + LTE corpus. The corpus is a single FTS5 SQLite file (~40 MB uncompressed, ~10 MB gzipped) downloaded to the per-user data directory on user opt-in. Source-of-truth pipeline lives in the [bugzilla-triage-corpus](https://github.com/mayhuifu/bugzilla-triage-corpus) repo (also published `rel17-v1` for the first time).

- **Pre-triage retrieval.** BM25 top-K over the local corpus, injected into the model's prompt as candidate references.
- **Post-triage enrichment.** Every clause the model emits is looked up in the corpus; matches attach `realText` + `title` + `parentTitle` + `source` to the `SpecExcerpt` for the CLASSIFICATION header to render.
- **Configurable manifest URL.** Defaults to GitHub Releases, but settable to any internal mirror (SharePoint / Confluence / S3) for users behind GitHub-blocked networks (mainland China). The manifest's `artifact.url` is followed transitively so a single override redirects everything.

Also folds in the never-tagged "v0.1.5 candidate" work that had been accumulating on main:

- **Version badge** (`v0.1.x`) in the top-left banner of every page.
- **Light-mode polish** — accent text colors and dark-only backgrounds now invert correctly via CSS-variable indirection on Tailwind palettes.
- **CLASSIFICATION header** at the top of every AI-authored Bugzilla comment, built server-side from confidence + domain + specReferences + specExcerpts.

### Changes

- New `lib/corpus/{store,manifest,downloader,retriever}.ts` — lazy SQLite singleton, atomic-rename downloader with sha256 verify, BM25 search + tolerant-regex clause lookup.
- New routes: `GET /api/corpus/status`, `POST /api/corpus/download`, `GET /api/corpus/lookup`.
- `lib/types.ts` — `SpecExcerpt` gains optional `clauseId` / `title` / `parentTitle` / `realText` / `source` (all backwards-compatible).
- `lib/settings.ts` — new `corpusManifestUrl` / `corpusVersion` / `corpusAutoUpdate` fields.
- `lib/llm.ts` — `runTriage` threads `opts.retrievedClauses` into `buildUserPrompt`; both provider paths call `enrichExcerptsWithCorpus()` before `withClassificationPrepended()`. Bug fixes from smoke testing: FTS5 query uses explicit `OR` (default is AND), tokens strip dots before MATCH.
- `app/api/tickets/[id]/triage/route.ts` + `/followup` — call `retrieveContext(ticket)` before `bridgeTriage`.
- `next.config.mjs` — `serverExternalPackages: ["better-sqlite3"]`.
- `electron-builder.json` — `asarUnpack: ["**/*.node"]` plus explicit `extraResources` for `better-sqlite3` + `bindings` + `file-uri-to-path`.
- New dep: `better-sqlite3` (+ ~3 MB native binding per platform-arch).

### Upgrade notes

- The corpus is optional. App works exactly like v0.1.5 with no corpus installed (model paraphrase as the fallback).
- v0.1.5 was never tagged or published; its work is rolled into v0.1.6.
- China deployment: override `corpusManifestUrl` in Settings or via env-var `CORPUS_MANIFEST_URL` to point at your internal mirror.

---

## v0.1.4 — Dual-theme color system

**Tagged:** 2026-05-16  
**Published:** 2026-05-16 ([release page](https://github.com/mayhuifu/bugzilla-triage-desktop/releases/tag/v0.1.4))

### Highlights

Adds a **light theme** alongside the existing dark one. Default follows the OS appearance (`prefers-color-scheme`); switch any time from **Settings → Appearance** (System / Light / Dark).

System mode live-updates while the app is open if you toggle Light/Dark in System Settings.

### Changes

- New `components/theme/ThemeManager.tsx` and the inline `<head>` bootstrap script in `app/layout.tsx` for no-FOUC theme application on first paint.
- `lib/settings.ts` — new `themeMode: "system" | "light" | "dark"` field.
- `tailwind.config.ts` + `app/globals.css` — `slate.*` color scale is now backed by CSS variables; light-mode flips inverted values so existing `text-slate-100` etc. flips automatically without touching ~200 component sites.

### Upgrade notes

- Existing settings.json files auto-migrate (the new `themeMode` defaults to `"system"`).

---

## v0.1.3 — DeepSeek compatibility + neutral "AI Triage Bot" rename

**Tagged:** 2026-05-16  
**Published:** 2026-05-16

### Highlights

Bug-fix release that addresses two issues surfaced after v0.1.2 launched multi-provider LLM support:

1. **DeepSeek triage failed** with `400 "This response_format type is unavailable now"`. The OpenAI-compatible path was using `response_format: json_schema`, which only OpenAI itself supports. Switched to the universally-supported `json_object` mode with the schema injected into the system prompt; defensive parsing strips ```json fences if the model adds them. Now works on DeepSeek, Ollama, Together, OpenRouter, Azure, vLLM, and real OpenAI.
2. **`"Analyzed by Claude"`** was the prefix and `cf_label` written to every AI-authored Bugzilla comment — misleading once the app supported non-Anthropic providers. Renamed everywhere to **`"Analyzed by AI Triage Bot"`**. Recognizers in `TicketComments` and `TicketTable` match both the new and the legacy strings so historical tickets still render with the AI styling.

### Upgrade notes

- No data migration. Old `"Analyzed by Claude"` tickets keep their styling.

---

## v0.1.2 — Multi-provider LLM config + manual triage mode

**Tagged:** 2026-05-16  
**Published:** 2026-05-16

### Highlights

- **Multi-provider LLM.** Settings → AI triage now exposes a Provider dropdown (Anthropic / OpenAI-compatible), an API base URL field, and a free-text "Custom…" option in the model picker. Works with corporate proxies (LiteLLM, Azure OpenAI, internal Anthropic gateways), local runners (Ollama, LM Studio, vLLM), and aggregators (OpenRouter).
- **Manual triage mode.** The triage panel now offers a **Manual Triage** button alongside **Run AI Triage**. Manual mode lets engineers type the analysis themselves and post to Bugzilla without invoking any LLM. The `manual:true` submit flag skips the `"Analyzed by Claude:"` prefix and the `Analyzed by Claude` cf_label (only AI-authored comments carry those).

### Upgrade notes

- Closes a key gap: the app no longer **requires** an LLM API key to do useful work with tickets — viewing + manual commenting now works with just Bugzilla credentials.

---

## v0.1.1 — First usable release

**Tagged:** 2026-05-16  
**Published:** 2026-05-16

### Highlights

The first installer that actually launches. **v0.1.0 was withdrawn** because the installer was missing bundled `node_modules` (the standalone Next.js server couldn't find `next` at runtime and exited immediately on macOS Sequoia + Apple Silicon).

Standalone desktop app for browsing Bugzilla tickets and running AI-assisted triage. No Node, Python, `claude` CLI, or `bugzilla-mcp` install needed — download, install, fill in URL + API key, go.

### Changes

- `electron-builder.json` — split `extraResources` into two entries so `node_modules` survives the implicit `!node_modules` filter (the PR-7 fix).

### Upgrade notes

- Start here. Do not install v0.1.0.

---

# Template for new releases

Copy this section verbatim when starting a new entry, then fill in the blanks. Drop empty subsections.

```markdown
## vX.Y.Z — <one-line summary> (unreleased)

**Tagged:** —
**Published:** —

### Highlights

- <2-5 bullets describing what changed in user-visible terms>

### Changes

- <file or module>: <what changed>
- ...

### Upgrade notes

- <data migrations, breaking changes, env-var renames, settings.json schema bumps>
- <"none — purely additive" is a perfectly fine line>
```

After the tag is pushed and CI completes:

1. Update the **Tagged** and **Published** lines.
2. Run `gh release edit vX.Y.Z --notes-file <(sed -n '/^## vX.Y.Z/,/^---$/p' RELEASES.md | sed '$d')` (or just paste the section).
3. `gh release edit vX.Y.Z --draft=false`.
