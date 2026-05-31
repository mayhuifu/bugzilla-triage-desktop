# v0.5.0 implementation plan — 3GPP Spec Workbench (full scope, hybrid embedder)

> **Status:** ⚙️ **Code complete (network-gated steps remain).** All
> network-independent code is built, typechecked, and verified against a running
> dev server + a production `next build`. The 3 steps that need outbound network
> — stage the embedder model, rebuild/publish corpus `rel17-v5`, verify the
> packaged installer — could NOT run in the build environment (no network) and
> are handed off below. See **"Implementation status"** at the bottom for the
> exact commands and what's done vs. remaining.

## Strategic goal

Turn `bugzilla-triage-desktop` into the engineer's **all-day workbench**, not just an
AI-triage tool. Three pillars, one app:

1. **Tickets** — read / filter / search (already shipped)
2. **Submit + AI triage** (already shipped)
3. **3GPP knowledge lookup** ← THIS RELEASE — standalone spec search, NOT gated behind AI triage

Validate the retrieval UX inside our own app first; external distribution (MCP server,
HTTP API, pip lib) is a deliberately deferred *later* phase that will reuse the same
retrieval core.

## Confirmed decisions

| Decision | Choice | Rationale |
|---|---|---|
| Scope | **Full** — search + drawer + TOC browse + acronym pane + cross-feature glue | User: "full scope and full feature" |
| Layout | **A** — search + result list + click-to-open SpecDrawer (modal) | Reuses the polished v0.4.1 SpecDrawer; zero new detail-view patterns |
| Search backend | **Hybrid (BM25 + dense + RRF), bundled up front** | User picked "bundle hybrid embedder" over "BM25 now". +0.063 MRR@10 measured at build time |
| Embedder model | **bge-small-en-v1.5** (384-dim, ~22 MB ONNX), English-only | Bundleable (bge-m3 is 570 MB — too heavy). 3GPP text is English so multilingual bge-m3 is overkill |
| Corpus | **Rebuild + republish as `rel17-v5`** with bge-small vectors | Desktop query-time embedder MUST produce vectors in the SAME space as the corpus's build-time vectors. Currently corpus is bge-m3 (1024-dim) → mismatch → must rebuild |
| Nav label | **"3GPP"** | Brevity in header chrome |
| LLM dependency | **Search is LLM-optional** | Retrieval needs no generative LLM. Optional "summarize results" button only appears when a provider is configured. Search works offline, no API key |
| Header tabs | "Triage Queue" (`/`) + "3GPP Specs" (`/spec`) | — |

## The load-bearing architecture problem (read this carefully)

**Why a corpus rebuild is required.** The desktop's hybrid path (`retrieveContextAsync`
in `lib/corpus/retriever.ts`) computes a query vector and does cosine similarity against
the corpus's `clauses_vec` table. Cosine is only meaningful if the query vector and the
stored vectors are in the **same embedding space** — i.e. produced by the same model.

- Corpus `rel17-v4` was built with **bge-m3** (1024-dim) → `meta.embeddingModel = "BAAI/bge-m3"`.
- bge-m3 ONNX is ~570 MB → can't bundle in the installer.
- So: rebuild corpus `rel17-v5` with **bge-small-en-v1.5** (384-dim, ~22 MB) → bundle the
  matching bge-small ONNX in the desktop → vector spaces match → hybrid works.

**The embedder hook already exists.** `lib/corpus/embedder.ts` defines:
```ts
interface CorpusEmbedder {
  readonly modelId: string;          // must === meta.embeddingModel on the open corpus
  embed(text: string): Promise<Float32Array>;  // L2-normalised, length === meta.embeddingDim
}
setCorpusEmbedder(embedder | null): void;   // call once at startup
getCorpusEmbedder(): CorpusEmbedder | null;
```
The retriever's `decidePath()` returns `"hybrid-rrf"` only when an embedder is registered
AND `embedder.modelId === meta.embeddingModel`. Today no embedder is registered → desktop
silently runs BM25. We close that gap.

**Recommended embedder implementation: `@huggingface/transformers` (Transformers.js).**
It bundles tokenization (BERT WordPiece) + ONNX runtime + model loading in one package and
supports bge-small-en-v1.5 end-to-end in Node. Far simpler than raw `onnxruntime-node` +
a hand-rolled tokenizer. Set `env.localModelPath` to a bundled model dir so it never hits
the network. Verify the output is L2-normalised (bge wants normalized embeddings; the
`feature-extraction` pipeline with `{ pooling: "cls", normalize: true }` does this).

**Packaging risk (the real one).** Whatever ONNX runtime we use ships per-platform native
`.node` binaries — same class of problem that bit us with better-sqlite3. electron-builder
must `asarUnpack` them and include the per-OS binary. Budget time for win/mac/linux
packaging verification. This is the single highest-risk item; de-risk it FIRST with a
spike before building the UI.

## Work breakdown (ordered by dependency + risk)

### Phase 0 — De-risk the embedder (DO THIS FIRST, ~1-2 days)
A throwaway spike to prove the riskiest piece before committing to UI work.
1. Add `@huggingface/transformers` to the desktop. Load bge-small-en-v1.5, embed a test
   string, confirm 384-dim L2-normalised output in plain `npm run dev`.
2. Confirm it runs under the **packaged Electron build** (not just dev) on at least macOS —
   `npm run dist:mac`, install, run, hit a test endpoint that embeds. This flushes out the
   ONNX native-binary packaging problem early.
3. If `@huggingface/transformers` packaging is painful, fall back to `onnxruntime-node` +
   bundled `tokenizer.json` (bge tokenizer) + manual CLS-pool + L2-normalise.
4. **Gate:** if neither runs in a packaged build within ~2 days, fall back to shipping
   v0.5.0 BM25-only (the UI is identical; only `decidePath` differs) and revisit the
   embedder as v0.6. Don't let packaging risk sink the whole feature.

### Phase 1 — Corpus rel17-v5 (corpus repo, ~half a day once Phase 0 confirms the model)
Repo: `/Users/huifu/bugzilla-triage-corpus` (work in the worktree
`.claude/worktrees/competent-taussig-e4e049`, branch off `main` which is at the Phase-1
figure merge `b231b82`).
1. Rebuild with `EMBED_MODEL=BAAI/bge-small-en-v1.5 npm run build` (skip fetch — `raw/` is
   populated). `embed_sidecar.py` already takes `EMBED_MODEL`; `03-index.ts` records
   `meta.embeddingModel/Dim/Dtype` from it.
2. Confirm `meta.embeddingModel = "BAAI/bge-small-en-v1.5"`, `embeddingDim = 384`.
3. Eval gate: bge-small may give a different (likely slightly lower) lift than bge-m3.
   The 20-query eval fix (corpus PR #3) should be MERGED first so the gate runs on valid
   IDs. Record the new MRR@10 numbers. If lift < the (aspirational) 0.15 it still ships —
   the gate is advisory (see corpus PR #3 discussion).
4. Keep `schemaVersion = 3` (figure_images unchanged). Only the embedding model changes.
5. Publish: `npm run publish-corpus -- --tag rel17-v5`. Note the new manifest URL.

### Phase 2 — Desktop embedder wiring (~1-2 days)
1. `lib/corpus/embedder-bge.ts` (new) — `CorpusEmbedder` impl using the Phase-0 runtime.
   `modelId = "BAAI/bge-small-en-v1.5"`, `embed()` → Float32Array(384), L2-normalised.
2. Register at server startup. Next.js: a `server-only` module imported by the corpus API
   routes, or an `instrumentation.ts` `register()` hook. Call `setCorpusEmbedder(new BgeEmbedder())`.
   Lazy-load the model on first `embed()` so app boot isn't blocked by ONNX init.
3. Bundle the model: add the bge-small ONNX + tokenizer to `extraResources` in
   `electron-builder.json` (mirror the sqlite-vec / better-sqlite3 pattern). Point the
   runtime's local-model path at the unpacked resource dir.
4. `electron-builder.json` — `asarUnpack` the ONNX runtime `.node` binaries.
5. Bump `lib/settings.ts` `DEFAULT_CORPUS_MANIFEST_URL` → rel17-v5; add rel17-v4 to
   `LEGACY_DEFAULT_CORPUS_MANIFEST_URLS`.
6. `lib/corpus/manifest.ts` — schemaVersion still {1,2,3}; no change needed (v5 is still
   schema 3).

### Phase 3 — Spec page UI (~2-3 days)
Layout A. Files:
```
app/spec/page.tsx              ← top-level page, client component
app/api/corpus/search/route.ts ← GET ?q=&limit= → hybrid retrieval top-N (JSON)
components/spec/SpecSearchBox.tsx   ← input, debounce, citation-vs-text detection
components/spec/SpecResultList.tsx  ← ranked cards
components/spec/SpecResultCard.tsx  ← citation · title · score · 200-char snippet · View clause
components/ui/HeaderNav.tsx          ← tab toggle Triage Queue / 3GPP (refactor existing header)
```
- Search box accepts: free text → hybrid; a citation (`TS 38.211 §7.4.2.2`) → direct
  `lookupClause` jump; an acronym (`HARQ`) → acronym expansion + related clauses.
- Reuse `<SpecDrawer>` (already has v0.4.1 resize + NOTE formatting + figure rendering) for
  the detail view — click a result → drawer opens.
- URL deep-linking: `/spec?q=PUSCH+DMRS` and `/spec?clause=TS+38.211+%C2%A77.4.2.2`.
- The `/api/corpus/search` route is the ONLY new retrieval surface; it calls
  `retrieveContextAsync`-style hybrid (refactor that fn to accept a raw query string, not
  just a `TicketDetail` — currently it takes a ticket; extract a `retrieveByText(query)`).

### Phase 4 — Stretch surfaces (~2-3 days)
1. **TOC sidebar** — `app/api/corpus/toc/route.ts` returns clause hierarchy for a spec
   (derive from `clauses.clause_no` dotted prefixes). `components/spec/SpecTocSidebar.tsx`.
2. **Acronym pane** — `app/api/corpus/acronym/route.ts` over the `acronyms` table (152 rows).
   Typeahead like the assignee filter.
3. **Recently-viewed** — localStorage history of opened clauses.

### Phase 5 — Cross-feature glue (the strategic payoff, ~1-2 days)
1. **Ticket detail → "Research in 3GPP"** button next to "Run AI Triage" → opens
   `/spec?q={ticket.summary}`. LLM-optional (search runs without a provider).
2. **Spec result → "Create ticket about this clause"** → new-bug form pre-filled with the
   citation + clauseId.
3. **AI Triage panel → "View related clauses"** sibling to the existing per-citation
   "View clause" → runs the same retrieval the LLM saw, lets the engineer explore beyond
   the model's picks.
4. **Optional "✨ Summarize for this ticket"** on the spec page — appears only when a
   provider is configured; calls the LLM to explain why the top clauses matter. Clearly
   labeled as the only LLM-touching part of the page.

### Phase 6 — Ship
- Bump `package.json` → 0.5.0; write RELEASES.md v0.5.0 entry.
- Commit, tag `v0.5.0`, push, watch CI, publish (notes + draft→public) per standing pattern.
- **Smoke-test the packaged installer** on Windows before announcing — the ONNX embedder is
  new native surface; dev-mode success ≠ packaged-build success.

## Critical cross-repo contract notes

- `meta.embeddingModel` is the join key. Desktop embedder `modelId` MUST string-match it
  exactly (`"BAAI/bge-small-en-v1.5"`), else `decidePath()` refuses hybrid and silently
  falls back to BM25 — a SILENT correctness degrade, not an error. Add a startup log line
  confirming "hybrid active: embedder X matches corpus Y" vs "BM25 fallback: mismatch".
- `schemaVersion` stays "3" (figure_images is the v3 addition; v5 only swaps the embedding
  model). `SUPPORTED_SCHEMA_VERSIONS = {1,2,3}` already covers it.
- The dense vectors are float16 in the JSONL sidecar, decoded to a vec0 BLOB at index time.
  bge-small is 384-dim → `clauses_vec` becomes `FLOAT[384]` automatically from `meta.embeddingDim`.

## Where the relevant code lives TODAY (so you don't have to re-discover it)

**Desktop** (`/Users/huifu/bugzilla-triage-desktop`):
- `lib/corpus/retriever.ts` — `retrieveContext` (sync BM25), `retrieveContextAsync` (hybrid),
  `lookupClause` (exact + ancestor fallback), `corpusHasSpec`, the RRF CTE (~line 270-300),
  `decidePath()` (~line 154), `RetrievedClause` / `ClauseFigure` / `ClauseFigureImage` types.
- `lib/corpus/store.ts` — `getCorpusDb`, `corpusHasVectors`, `corpusHasFigureImages`,
  `getFigureImagesForClause`, `getFigureImageBlob`.
- `lib/corpus/embedder.ts` — the `CorpusEmbedder` hook (currently no impl registered).
- `lib/corpus/manifest.ts` — `SUPPORTED_SCHEMA_VERSIONS = {1,2,3}`.
- `lib/settings.ts` — `DEFAULT_CORPUS_MANIFEST_URL` (rel17-v4), `LEGACY_DEFAULT_CORPUS_MANIFEST_URLS`.
- `components/triage/SpecDrawer.tsx` — the reusable detail view (resize + NOTE rows + figures).
- `app/api/corpus/{lookup,figure,status}/route.ts` — existing corpus API routes.
- `electron-builder.json` — `extraResources` per-platform native binary pattern (sqlite-vec,
  better-sqlite3); `asarUnpack: ["**/*.node"]`; `npmRebuild: false`.
- `app/page.tsx` — dashboard (the existing "Triage Queue" page; header chrome lives here).

**Corpus** (`/Users/huifu/bugzilla-triage-corpus`, worktree `.claude/worktrees/competent-taussig-e4e049`):
- `scripts/embed_sidecar.py` — sentence-transformers, takes `EMBED_MODEL` env (default bge-m3).
- `scripts/embed.ts` — orchestrates the sidecar, writes float16 JSONL.
- `scripts/03-index.ts` — builds SQLite, records `meta.embeddingModel/Dim/Dtype`, `schemaVersion="3"`.
- `scripts/05-eval.ts` — eval gate (reads `eval_queries` from SQLite). PR #3 fixes 20 stale IDs.
- `scripts/04-publish.ts` — gzip + sha256 + manifest + `gh release`; tag must match `relNN-vN`.
- `main` is at `b231b82` (Phase-1 figure merge). PR #3 (eval-queries fix) is OPEN — merge before rebuild.

## State as of this plan (already shipped / in-flight)

- Desktop `v0.4.1` — CI was building at plan time (run `26678473968`); watcher `bstvgzu9r`
  armed to auto-publish. SpecDrawer resize + NOTE-row fixes.
- Corpus `rel17-v4` — published, schemaVersion=3, bge-m3, 1,128 figure images.
- Corpus PR #2 (Phase-1 figures) — MERGED to main.
- Corpus PR #3 (eval-queries fix) — OPEN, needs merge before the v5 rebuild so the eval gate runs.
- Desktop `main` HEAD includes the v0.4.1 commits (resize `a8ad15a`, NOTE span `e41f2ef`,
  NOTE split `6f8c65b`, version bump `8c4ede6`).

## Verification matrix

| Check | Expected |
|---|---|
| Phase 0 spike: embed a string in `npm run dev` | 384-dim Float32Array, L2 norm ≈ 1.0 |
| Phase 0 spike: same in **packaged** build | works on macOS (then win/linux in CI) |
| Corpus rel17-v5 built | `meta.embeddingModel=BAAI/bge-small-en-v1.5`, `embeddingDim=384`, golden 9/9 |
| Desktop startup log | "hybrid active" (NOT "BM25 fallback: model mismatch") |
| `/api/corpus/search?q=PUSCH+DMRS` | returns top-N with `retrieverPath: "hybrid-rrf"` |
| `/spec` page | search box → results → click → SpecDrawer with figures |
| Search with NO provider configured | still returns results (LLM-optional) |
| Ticket → "Research in 3GPP" | opens `/spec?q=…`, results render |
| Packaged installer (Windows) | embedder loads, hybrid active, no ERR_DLOPEN |

## Risk register

| Risk | Mitigation |
|---|---|
| **ONNX native binary packaging** (highest) | Phase 0 spike on a packaged build BEFORE UI work. Fallback: ship BM25-only v0.5.0, embedder as v0.6 |
| bge-small lower precision than bge-m3 | Eval gate measures it; BM25 fusion floor still holds. English-only is fine for 3GPP |
| Silent BM25 fallback on modelId mismatch | Startup log line + a `/api/corpus/status` field exposing `hybridActive: bool` |
| Installer size bloat (+22-130 MB ONNX) | bge-small quantized (int8) is ~22 MB; acceptable. Document in RELEASES |
| Corpus eval gate fails on bge-small | Advisory gate (corpus PR #3 discussion) — ships anyway, record the number |
| Cross-feature glue scope creep | Phases 4-5 are independently shippable; can split to v0.6 if v0.5 runs long |

## Out of scope for v0.5 (explicit)

- MCP server / HTTP API / pip lib (the external-distribution phase — deferred until the
  in-app UX is validated).
- Server-side SVG→PNG rasteriser for LLM vision over the 921 SVG figures (separate follow-up).
- NAS specs (TS 24.501 / 24.301).
- `@umsemi/3gpp-rag-core` extraction (the refactor that enables external consumers) — do it
  WHEN we build the MCP server, not before; premature for an in-app-only feature.

---

## Implementation status (2026-05-31)

### ✅ Done (code complete, verified offline)

All built, `npx tsc --noEmit` clean, `next build` clean, and smoke-tested against
a running dev server (the installed `rel17-v3/4` bge-m3 corpus, which correctly
exercises the **BM25 fallback + model-mismatch detection** since the bundled
embedder is bge-small):

- **Phase 2 — retriever + embedder**
  - `lib/corpus/retriever.ts`: `retrieveByText(query,{limit})`, `tokenizeText`,
    `buildQueryFromText`, `activeRetrieverPath()`, limit-parameterised
    `bm25Retrieve`/`hybridRetrieve`, lazy embedder registration in `decidePath()`.
  - `lib/corpus/embedder-bge.ts` (new): bge-small `CorpusEmbedder`, lazy offline
    model load, `ensureBgeEmbedderRegistered()`, `BGE_EMBEDDER_MODEL_ID`.
  - `next.config.mjs`: externalised `@huggingface/transformers` + `onnxruntime-node`.
  - `lib/settings.ts`: default URL → `rel17-v5`; `rel17-v4` added to legacy set.
  - `app/api/corpus/status`: now reports `retrieverPath`/`hybridActive`/`embeddingModel`/`queryEmbedderModel`.
  - **Verified:** dev log prints the BM25-fallback notice; `/api/corpus/status`
    returns `hybridActive:false, embeddingModel:"BAAI/bge-m3", queryEmbedderModel:"BAAI/bge-small-en-v1.5"`.
- **Phase 3 — /spec UI:** `app/spec/page.tsx`, `components/spec/{SpecSearchBox,SpecResultList,SpecResultCard}.tsx`,
  `components/ui/HeaderNav.tsx`, `app/api/corpus/search/route.ts`. HeaderNav wired into the dashboard too.
  **Verified:** `/spec` → HTTP 200; search free-text + citation-jump both return correct results.
- **Phase 4 — sidebar:** `app/api/corpus/{toc,acronym}/route.ts`, `components/spec/{SpecAcronymPane,SpecTocSidebar}.tsx`,
  recently-viewed (localStorage). **Verified:** routes return specs/clauses/acronyms.
- **Phase 5 — glue:** "Research in 3GPP" on the ticket header + the triage button group → `/spec?q={summary}`.
- **Phase 6 — packaging + version:** `electron-builder.json` (models dir + per-OS ONNX native libs),
  `scripts/fetch-embed-model.mjs`, `scripts/spike-embedder.mjs`, `package.json` → `0.5.0` + `fetch:model`/`spike:embedder` scripts, `.gitignore` `/models/*`, RELEASES.md v0.5.0 entry.

### ⏳ Remaining — NETWORK-GATED (run on a networked machine, in order)

1. **Stage the embedder model:** `npm run fetch:model` → populates `models/Xenova/bge-small-en-v1.5/`.
   Smoke test: `npm run spike:embedder` → expect `dim=384 L2≈1.0 … PASS`.
   (If the spike fails on packaging, the Phase-0 fallback in §"Phase 0" applies: ship BM25-only.)
2. **Corpus `rel17-v5`** (repo `/Users/huifu/bugzilla-triage-corpus`): MERGE corpus PR #3 (eval-queries fix)
   first → `EMBED_MODEL=BAAI/bge-small-en-v1.5 npm run build` (skip fetch; `raw/` is populated) →
   confirm `meta.embeddingModel=BAAI/bge-small-en-v1.5`, `embeddingDim=384`, golden 9/9 →
   `npm run publish-corpus -- --tag rel17-v5`. Record the eval MRR@10 number (advisory gate).
3. **Packaged-build verification (the real de-risk):** `npm run dist:win` (after step 1 staged the model) →
   install → download v5 corpus → `/api/corpus/status` must show `hybridActive:true` and the `/spec`
   badge must read **Hybrid retrieval**. Watch for `ERR_DLOPEN` / missing onnxruntime DLL — if it fails,
   ship BM25-only v0.5.0 (UI identical) and treat the embedder as a v0.6 follow-up.
4. **Ship:** tag `v0.5.0`, push, watch CI, publish (notes from RELEASES.md, draft→public) per standing pattern.

### ⏭️ Deferred (out of v0.5, rationale)

- **"Create ticket about this clause"** — the app has no new-bug form (only submit-to-existing-ticket);
  `enter_bug.cgi` prefill is server-config-dependent. The `SpecResultCard` already accepts an optional
  `onCreateTicket` prop, so it's a small future add once a new-bug flow exists.
- **"✨ Summarize for this ticket"** (LLM) — deliberately omitted to keep `/spec` purely LLM-optional;
  revisit as a clearly-labeled opt-in in v0.6.
