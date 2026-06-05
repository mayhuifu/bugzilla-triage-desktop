# v0.5.5 — Cross-encoder reranker (Phase A of next-gen RAG)

> **Status:** Approved, not started. Durable hand-off — written to survive a
> context `/compact`. Read top-to-bottom before writing code. Full strategy
> context: `bugzilla-triage-corpus/PLAN-nextgen-rag.md`.

## Goal

Fix the **"right clause is in the results but ranked low"** hit-rank problem by
adding a **cross-encoder reranker** on top of the existing hybrid retrieval.
Ship as desktop **v0.5.5**. Plus a **prerequisite eval-set expansion** so the
win is measured.

Stay within the product invariants: **offline, single SQLite artifact,
LLM-optional at runtime, in-process desktop.** The reranker is a small local
ONNX (NOT a generative LLM) — same class as the bge-small embedder already
shipped in v0.5.

## Why this is the right fix (evidence)

`rel17-v5` build eval: baseline BM25 MRR@10 0.181 / R@1 0.13 / R@10 0.31 →
hybrid 0.205 / **R@1 0.08** / R@10 0.46. Hybrid **raised recall but dropped
top-1** — the right clause lands in the top-K, just not first. A cross-encoder
reranker reorders the top-K to put the best result first. No corpus rebuild
needed (reranker scores `(query, clause.text)` and the text is already in SQLite).

## Versioning

- This release = desktop **v0.5.5** (user directive: stay in 0.5.x; bump to 0.5.5).
- **No corpus version change** — still `rel17-v5`. Phase A is desktop-only.

## State at time of writing (so you don't re-discover it)

- Desktop is at **v0.5.1** (`package.json` version "0.5.1"), git `main` HEAD
  `76f0606` (+ `a0db429` docs). Working tree clean.
- Corpus shipped: **rel17-v5** (bge-small-en-v1.5, 384-dim, schema 3), the
  default in `lib/settings.ts` `DEFAULT_CORPUS_MANIFEST_URL`.
- v0.5 already proved the ONNX-bundling pattern we will REUSE verbatim:
  - `scripts/fetch-embed-model.mjs` — stages an HF model into `models/` before
    `dist:*`. CI runs it (`.github/workflows/release.yml` "Stage embedding model").
  - `electron-builder.json` — `extraResources` copies `models/` +
    `node_modules/onnxruntime-node/bin/napi-v6/<os>` per platform; `asarUnpack`
    the `.node`. onnxruntime-node napi-v6 is ABI-stable across Node/Electron.
  - `@huggingface/transformers@4.2.0` already a dependency; loads ONNX offline
    via `env.localModelPath` / `env.allowRemoteModels=false`.
  - `lib/corpus/embedder.ts` = the `CorpusEmbedder` hook pattern to mirror.
  - `lib/corpus/embedder-bge.ts` = the concrete embedder impl to mirror.
  - `lib/corpus/retriever.ts` = `retrieveByText(query)` (hybrid) + `retrieveContextAsync`;
    the reranker slots in AFTER candidate generation.

## Prerequisite — expand the eval set (corpus repo; ~1–2 days; DO FIRST)

Can't tune what we can't measure. The current `scripts/eval-queries.json`
(48 queries) under-represents the failing cases.

- Repo: `bugzilla-triage-corpus` (worktree `.claude/worktrees/competent-taussig-e4e049`).
- Add stratified **failing** queries with expected leaf clause IDs, tagged by
  stratum, covering the 3 confirmed modes — especially **ranked-low** (clause
  exists but currently ranks > 1) and a few **figure/table-answer** and
  **relational** ones (for later phases). Ideally sourced from real engineer
  queries.
- The eval gate (`scripts/05-eval.ts`) already measures baseline-vs-hybrid; we
  will extend it (or add a sibling) to also measure **+reranker** so v0.5.5's
  lift is quantified. NOTE: 05-eval runs inside the corpus build; the reranker
  lives in the desktop. Two options: (a) port the reranker scoring into a small
  corpus-side eval script (Python/TS using the same model), or (b) add a
  desktop-side `scripts/dev-rerank-eval.ts` that opens the corpus + reranks the
  eval_queries and reports MRR@10 / R@1 before vs after rerank. **(b) is
  simpler and keeps the reranker in one place** — recommend (b).

## Phase A implementation (desktop; ~3–4 days)

### 1. Pick the reranker model (spike first)

Cross-encoder, must have a Transformers.js-compatible ONNX, small enough to
bundle. Candidates (spike + measure on the expanded eval set, pick by
quality/size):

| Model | ~size (q8) | Notes |
|---|---|---|
| `Xenova/ms-marco-MiniLM-L-6-v2` | ~23 MB | Smallest; English MS-MARCO general |
| `Xenova/bge-reranker-base` | ~110 MB | Stronger; bigger installer hit |
| `mixedbread-ai/mxbai-rerank-xsmall-v1` | small | Check ONNX availability |

Default recommendation: **start with `ms-marco-MiniLM-L-6-v2`** (tiny, proven);
upgrade to `bge-reranker-base` only if eval shows it's worth the ~90 MB.

Spike (mirror `scripts/spike-embedder.mjs`): load the model via Transformers.js
as a **sequence-classification / text-ranking** model, score a few
`(query, passage)` pairs, confirm a relevant passage outscores an irrelevant
one, and that it loads offline. Transformers.js: there isn't a one-call
"rerank" pipeline — run `AutoModelForSequenceClassification` + tokenizer on the
pair and read the logit, OR use the `text-classification` pipeline if the model
exposes a single relevance logit. Verify the exact API in the spike.

### 2. Stage + bundle the model

- Extend `scripts/fetch-embed-model.mjs` (or add `fetch-reranker-model.mjs`) to
  download the chosen reranker into `models/<Org>/<model>/`.
- `electron-builder.json` already globs `models/` via extraResources — the new
  model dir ships automatically. Confirm.
- CI: the "Stage embedding model" step must also stage the reranker (add to the
  same `npm run fetch:model`, or a new `fetch:reranker` invoked alongside).

### 3. Reranker hook + impl (mirror the embedder)

- `lib/corpus/reranker.ts` (new) — a `CorpusReranker` hook:
  `{ modelId: string; rerank(query: string, passages: string[]): Promise<number[]> }`
  returning a relevance score per passage. `setCorpusReranker` / `getCorpusReranker`,
  mirroring `embedder.ts`.
- `lib/corpus/reranker-ce.ts` (new) — concrete impl using Transformers.js,
  loading from the bundled `models/` dir offline (mirror `embedder-bge.ts`).
  Lazy-load the model on first `rerank()`. Batch the pairs.
- Register at startup wherever `setCorpusEmbedder` is registered today
  (the server-only bootstrap the corpus API routes import).

### 4. Wire into retrieval

- In `lib/corpus/retriever.ts`: after `retrieveByText` (hybrid RRF) returns the
  top-K candidates (raise the candidate K to ~30), if a reranker is registered,
  call `rerank(query, candidates.map(c => c.text))`, sort by reranker score,
  return top-N. If no reranker registered → current behavior unchanged
  (graceful, LLM-optional, also covers older builds).
- Add a `retrieverPath` value like `"hybrid-rrf+rerank"` so
  `/api/corpus/status` and the `/spec` badge can show reranking is active.
- The `/api/corpus/search` route already maps `retrieverPath` to the card —
  surface the new path.

### 5. Eval + tune

- Run the desktop-side rerank eval (prerequisite step b) on the expanded set.
- Expect a clear **R@1 / MRR@10** jump vs hybrid-only. Record the numbers.
- Tune candidate-K (30 vs 50) and top-N.

### 6. Ship v0.5.5

- `package.json` → 0.5.5; RELEASES.md v0.5.5 entry (Tagged/Published dates).
- Commit, tag `v0.5.5`, push, watch CI, publish (notes + draft→public) per the
  standing pattern (gh release edit --notes-file --draft=false).
- **Windows-install smoke test** (the recurring open item): confirm the reranker
  ONNX loads in the packaged build and `retrieverPath` shows rerank active.

## Cross-repo contract notes

- Reranker is **desktop-only**; the corpus (`rel17-v5`) is unchanged. No schema
  bump, no `meta` change.
- Installer size grows by the reranker ONNX (~23 MB MiniLM or ~110 MB bge). Note
  it in RELEASES.
- Keep retrieval **LLM-optional**: reranker is a local ONNX. No network at query
  time (loads from bundled `models/`).

## Verification matrix

| Check | Expected |
|---|---|
| Spike: score (query, relevant) vs (query, irrelevant) | relevant scores higher; loads offline |
| Rerank eval on expanded set | R@1 / MRR@10 up vs hybrid-only; record numbers |
| `/api/corpus/status` | `retrieverPath: "hybrid-rrf+rerank"`, rerankerActive true |
| `/spec` search | top result is the best of the top-K (the "ranked low" fix) |
| No reranker registered (older build / failure) | falls back to hybrid, no crash |
| Packaged build (mac, then win in CI) | reranker ONNX loads; no ERR_DLOPEN |

## Risk register

| Risk | Mitigation |
|---|---|
| Reranker ONNX size bloats installer | Start with MiniLM (~23 MB); upgrade only if eval demands |
| Transformers.js has no turnkey rerank API | Spike the `AutoModelForSequenceClassification` path first |
| Rerank latency on first query (model load) | Lazy-load + warm on first search; cache pipeline (mirror bge) |
| Per-query rerank latency (K pairs) | K≈30, batch the forward pass; measure (target < ~200 ms warm) |
| Eval set too small to show lift | Expand it FIRST (prerequisite) with real failing queries |

## Out of scope for v0.5.5 (later phases — see PLAN-nextgen-rag.md)

- Phase B: MinerU parsing + VLM figure captioning (corpus rel17-v6, schema v4).
- Phase C: knowledge-graph-augmented retrieval (build-time KG in SQLite).
- Any RAG-Anything runtime adoption (that's the deferred server-side §6 platform).
