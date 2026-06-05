# v0.5.6 — Multimodal parsing + figure captioning (Phase B of next-gen RAG)

> **Status:** Approved, not started. Durable hand-off — survives a `/compact`.
> Strategy: `bugzilla-triage-corpus/PLAN-nextgen-rag.md`. Reranker patterns +
> ONNX-bundling reference: `PLAN-v0.5.5-reranker.md`. Do Phase A (v0.5.5) first.

## Goal

Fix **"the answer is in a figure or table"** hit-rank failures, AND fix the
**misformed-table** extraction problem (raised by the maintainer earlier). Two
build-time upgrades; the runtime artifact stays a single SQLite.

1. **Higher-fidelity parsing** — replace mammoth + soffice with MinerU/Docling.
2. **VLM figure captioning** — generate a semantic caption per figure at build
   time so diagrams become searchable by *content*, not just their `Figure N:`
   label.

Ships as desktop **v0.5.6** consuming a rebuilt corpus **rel17-v6** (schema v4).

## Invariants (unchanged)

Offline, single SQLite, LLM-optional at *runtime*. Any LLM/VLM here is
**build-time only**, one-time, offline; its output is baked into the artifact.

## Versioning

- Desktop **v0.5.6** (reads schema v4).
- Corpus **rel17-v6**, `meta.schemaVersion = "4"`.
- Phase A reranker (v0.5.5) stays in place and reranks the now-better candidates.

## Why this helps the stated failure mode

Today figures are paired by the nearby `Figure N:` caption only; the diagram's
*content* is invisible to retrieval. A VLM caption ("SRS time mask with 10 µs
transient periods in the blanked SRS symbol…") makes the figure matchable by
what it shows. MinerU/Docling also produce clean table structure (our current
mammoth+soffice tables are sometimes misformed), so table-answer queries match
the actual cells.

## State to know

- Current parse: `scripts/02-parse.ts` (corpus) — mammoth DOCX→HTML → leaf-clause
  split by clause-number depth; tables via mammoth `<table>`; figures via the
  `convertImage` callback + `media-utils.ts` soffice WMF/EMF→SVG; figure↔caption
  pairing ±3 paragraphs. Schema v3, `figure_images` BLOB table.
- Source docs are **DOCX** (from 3gpp.org, fetched by `01-fetch.ts`; some legacy
  `.doc` upgraded via libreoffice). 38.201 is a legacy .doc edge case.
- Corpus repo: `bugzilla-triage-corpus` (worktree
  `.claude/worktrees/competent-taussig-e4e049`).

## Implementation (corpus build; ~1–2 weeks)

### 1. Spike the parser (decide MinerU vs Docling FIRST)

- **MinerU** (opendatalab) — best-in-class layout/table/equation extraction,
  but PDF-oriented and heavy (downloads models, GPU strongly preferred). For our
  DOCX source we'd likely convert DOCX→PDF (libreoffice) → MinerU.
- **Docling** (IBM) — handles DOCX natively, lighter, good table structure.
  Likely the better fit for a DOCX corpus + a CI/offline build.
- **Spike both** on 3–4 representative specs (incl. a test spec like 38.521-1 and
  a heavy-table one like 36.133 §8.20.2.1 and 38.101-1 §6.3.3.6 figures). Compare:
  table fidelity, figure extraction, equation handling, reading order, build time,
  and whether the **leaf-clause numbering** still recovers cleanly.
- **Decision gate:** pick the one that keeps the leaf-clause split intact and
  improves tables/figures. Keep `parseHeading`/leaf-detection logic; swap only
  the extractor underneath.

### 2. Rewire `02-parse.ts`

- Replace the mammoth pipeline with the chosen parser's output, mapping back to
  our clause record shape (`{ id, citation, title, path, text, tables[], figures[], … }`).
- Tables: store the parser's structured cells (cleaner than today's pipe-flatten).
- Figures: extract images as today into `dist/media/<spec>/…`; keep the
  `figure_images` BLOB ingestion in `03-index.ts`.
- Re-verify the two documented parse gaps (38.201 legacy .doc; test-spec styles)
  — MinerU/Docling may resolve them for free.

### 3. VLM figure captioning (new build step)

- New script `scripts/caption-figures.ts` (+ a Python sidecar if needed):
  for each figure image, call a VLM once (OpenAI/Anthropic/local) to produce a
  concise factual caption. Cache by image hash so re-runs are cheap.
- Store the caption: add `vlmCaption` to each `figures_json` entry; ALSO append
  it to the clause's indexed `text` (or a dedicated FTS column) and include it in
  the embedded text so it influences both BM25 and dense retrieval.
- Cost: one-time over ~1.1k captioned figures (was 1,148 in rel17-v5). Budget +
  a model choice knob (env, like `EMBED_MODEL`).

### 4. Schema v4 (`03-index.ts`)

- `meta.schemaVersion = "4"`; record the parser + VLM model identity in `meta`.
- Add figure-caption fields; widen FTS to index captions; keep `figure_images`.
- Golden-snippet validation must still pass (update goldens only if verified
  against the new parse output).

### 5. Eval + publish

- `05-eval.ts`: the expanded eval set (from Phase A prerequisite) must include
  **figure/table-answer** queries; measure recall on that stratum before/after.
- Publish `npm run publish-corpus -- --tag rel17-v6`.

### 6. Desktop v0.5.6

- `lib/corpus/manifest.ts`: `SUPPORTED_SCHEMA_VERSIONS` add `4`.
- `lib/settings.ts`: `DEFAULT_CORPUS_MANIFEST_URL` → rel17-v6; add rel17-v5 to
  `LEGACY_DEFAULT_CORPUS_MANIFEST_URLS`.
- `SpecDrawer` / search: surface VLM captions (e.g. show under the figure; let
  them drive the figure/table chips). Better table structure renders via the
  existing `ClauseTable`.
- Bump `package.json` → 0.5.6; RELEASES.md entry; ship per standing pattern.

## Cross-repo contract

- `meta.schemaVersion = "4"` (additive over v3 — older desktops ignore new
  columns, but set `SUPPORTED_SCHEMA_VERSIONS` to include 4 in v0.5.6).
- Artifact size will grow (better tables + captions text; figure blobs ~same).
- Runtime still LLM-optional; captions are precomputed.

## Verification matrix

| Check | Expected |
|---|---|
| Parser spike on 3–4 specs | tables/figures cleaner than mammoth; leaf split intact |
| Build rel17-v6 | schemaVersion 4, captions present, goldens pass |
| Figure/table-answer eval stratum | recall up vs rel17-v5 |
| Misformed-table spot check (36.133 §8.20.2.1) | cells correct |
| Desktop v0.5.6 reads v4 | figures show VLM captions; tables render clean |

## Risk register

| Risk | Mitigation |
|---|---|
| MinerU PDF-oriented / heavy / GPU | Prefer Docling for DOCX; spike both; convert DOCX→PDF only if MinerU wins |
| Parser swap breaks leaf-clause logic | Keep numbering logic; gate on goldens + clause counts per spec |
| VLM captioning cost | One-time; cache by image hash; cap/parameterize the model |
| Schema bump breaks older desktop | Additive; bump SUPPORTED_SCHEMA_VERSIONS; legacy URL fallback |
| Build env now needs a VLM + parser models | Document deps; keep build offline/one-time |

## Out of scope (→ later)

- Phase C knowledge graph (v0.5.7).
- RAG-Anything runtime adoption (server-side §6 platform).
