# v0.5.5 Phase A — reranker eval findings (and the better fix we found)

> **TL;DR:** The planned Phase A cross-encoder reranker **regresses** hit-rank
> on every model/config tested. The real hit-rank win — discovered while
> eval-gating the reranker — is **deprioritising conformance-test specs in
> candidate generation: +8.4pp R@1 / +7.5pp MRR@10**, a desktop-only change
> with no corpus rebuild. Reranker code is kept in-tree but **default-OFF**
> (`CORPUS_RERANK=1` to enable) pending a verified eval set + domain-tuned model.

## What was built (all in-tree, working)

- `scripts/spike-reranker.mjs` — proved Transformers.js cross-encoder loads &
  ranks (PASS). Key insight: must feed `<title>. <text>` (titles spell out
  acronyms the body abbreviates).
- `lib/corpus/reranker.ts` + `reranker-ce.ts` — `CorpusReranker` hook + ONNX
  cross-encoder impl (mirrors the bge embedder). **Registration is gated on
  `CORPUS_RERANK=1` — OFF by default** because of the eval below.
- `lib/corpus/retriever.ts` — `hybridRetrieve()` widens the candidate pool to
  `RERANK_CANDIDATE_K` and reranks when a reranker is registered; new path
  `"hybrid-rrf+rerank"`; concise `rerankQuery` (capped at 512 chars).
- `scripts/fetch-reranker-model.mjs`, `package.json` (`fetch:reranker`,
  `fetch:models`, `spike:reranker`), `.github/workflows/release.yml`, status
  route + `/spec` badge — all wired.
- `scripts/dev-rerank-eval.mjs` — the eval gate. Re-implements production
  candidate-gen (acronym expansion + NR/LTE bias + the exact RRF CTE) and the
  rerank step, measuring MRR@10 / R@1 / R@10 hybrid vs hybrid+rerank.

## The eval (rel17-v5 corpus, schema 3, bge-small; 48-query set)

Hybrid baseline matched the corpus build eval (≈0.205 MRR@10 / 0.08 R@1), so
the harness is sound.

| Config | MRR@10 | R@1 | R@10 | verdict |
|---|---|---|---|---|
| hybrid (RRF) — today's default | 19.7 | 10.4 | 45.8 | baseline |
| hybrid + ms-marco-MiniLM-L-6-v2 (q8, replace, K30) | 18.4 | 8.3 | 43.8 | −1.3 / −2.1 ❌ |
| hybrid + bge-reranker-base (q8, replace, K30) | 15.4 | 4.2 | 41.7 | −4.3 / −6.3 ❌ |
| hybrid + ms-marco (fuse, K10) | 19.7 | 10.4 | 45.8 | ~0 (no help) |
| **hybrid + test-spec hard-exclude (no rerank)** | **27.9** | **18.8** | 45.8 | **+8.2 / +8.4 ✅** |
| **hybrid + test-spec soft down-weight (no rerank)** | **27.2** | **18.8** | 45.8 | **+7.5 / +8.4 ✅** |
| hybrid + test-spec filtered + ms-marco rerank | 24.1 | 14.6 | 43.8 | rerank still −3.9 / −4.2 ❌ |

## Why the reranker regresses (root causes, from DEBUG dumps)

1. **Eval labels favour `…X.1 «General»` normative stubs.** Many expected
   answers are the generic intro sub-clause. General web-search cross-encoders
   (correctly, by their training) prefer the *specific* procedural sibling.
   e.g. qid 1 "RRC reconfiguration with sync after handover" → reranker #1 was
   `38.331#5.3.5.5.2 «Reconfiguration with sync»`, arguably a *better* answer
   than the labelled `5.3.5.1 «General»`. So the reranker "loses" on debatable
   labels.
2. **Test specs flood the candidate pool.** Nearly every hybrid top-5 was
   `38.523-1` / `36.133 Annex A` conformance-test clauses crowding out the
   normative `38.331/38.321` clause. This hurt *both* arms — and removing it is
   the actual win.
3. **~40% of queries are pure recall misses** (expected clause not in the
   top-50 pool). Reranking can't help those; it only churns the window.

R@10 dips under reranking because reordering the top-K can push a clause that
was at hybrid rank 8–10 out of the top-10.

## The real fix: deprioritise conformance-test specs

All 48 expected answers are **normative** specs (38.331, 38.321, 38.211, …);
**zero** are test specs. So down-ranking the conformance test series
(`38.523-1`, `36.523-1`, `38.521-*`, `36.521-*`, `38.508-1`, `36.508`) in
candidate generation removes only pollution. Soft down-weight (multiply RRF
score by ≤0.5) captures the full gain while keeping test specs available below
normative clauses — important because test specs were added to the corpus on
purpose (rel17-v3) and some queries genuinely want them.

Gain: **R@1 10.4% → 18.8% (+8.4pp), MRR@10 19.7 → 27.2 (+7.5pp), R@10 flat** —
i.e. the right answers were always retrieved, just buried.

## Recommendation

1. **Ship the test-spec deprioritisation as v0.5.5** (desktop-only retriever
   change; no corpus rebuild) — it is the evidenced hit-rank fix.
2. **Keep the reranker dormant** (`CORPUS_RERANK=1` to enable). Revisit only
   with (a) a verified, normative-focused eval set with acceptable-answer SETS
   (not single `«General»` stubs), and (b) possibly a domain-tuned reranker.
   Don't bundle the 23 MB reranker ONNX in installers while it's off.
3. **Build the verified eval set** (the plan's load-bearing prerequisite) +
   address the ~40% recall misses — those are the next hit-rank levers, bigger
   than reranking.

## Verified-set re-measurement (final v0.5.5 numbers)

After building the verified eval set (63 queries; every clause id confirmed to
exist as a normative leaf; `acceptableClauseIds` so a defensible sibling answer
isn't a false miss; mode strata top1/ranked-low/recall-miss + 3 figure-table +
3 relational for Phases B/C), the test-spec demotion holds and strengthens:

| | MRR@10 | R@1 | R@10 |
|---|---|---|---|
| hybrid (test-spec pollution) | 34.0 | 20.6 | 61.9 |
| **hybrid + demotion (v0.5.5)** | **43.8** | **30.2** | **65.1** |
| lift | **+9.8pp** | **+9.6pp** | **+3.2pp** |

(Acceptable-answer scoring raises the baseline vs the strict single-label run —
because «General»-stub false-misses are now correctly credited — but the
demotion *delta* is consistent and slightly larger. R@10 rises too: test specs
were occupying top-10 slots.)

Curation also caught **mislabels** (now corrected in eval-queries.json): qid 51
→ `36.331#5.3.11.3` (T310/RLF), qid 52 → `36.331#5.3.11.1` (N310), qid 42 →
`38.101-1#6.5.4` (Tx intermodulation); and a **corpus parse-gap** for Phase B:
`38.213#10.1` (PDCCH-monitoring preamble with aggregation-level / search-space
definitions) is absent — only the `10.1.1` cross-carrier subclause survived.

## Repro

```bash
cd bugzilla-triage-desktop
node scripts/dev-rerank-eval.mjs                       # hybrid vs ms-marco rerank
RERANK_MODEL=Xenova/bge-reranker-base node scripts/dev-rerank-eval.mjs
TEST_SPEC_PENALTY=0.25 node scripts/dev-rerank-eval.mjs   # soft down-weight (the win)
EXCLUDE_TEST_SPECS=1 node scripts/dev-rerank-eval.mjs     # hard exclude (upper bound)
DEBUG=1 DEBUG_N=8 node scripts/dev-rerank-eval.mjs        # per-query before/after dump
```
Defaults point at `out/corpus.sqlite` (rel17-v5) and the corpus repo's
`scripts/eval-queries.json`. Override with `CORPUS=` / `QUERIES=`.

---

## Update 2026-06 — re-eval on the 73-query HARD set: a real win exists (HELD on size)

After Phase C added 10 hard relational multi-hop queries (eval set 48→73; strata
now top1/normal/ranked-low/recall-miss/**relational**), the reranker was re-measured
against the harder set. The old "all rerankers regress" conclusion was **mode- and
model-specific**. Findings (rel17-v5, `EXCLUDE_TEST_SPECS=1` = shipped-demotion-equivalent):

| model + mode | overall ΔMRR@10 | ΔR@1 | ΔR@10 | relational | ranked-low | top1 |
|---|---|---|---|---|---|---|
| ms-marco-MiniLM · replace | −4.0 | −2.7 | −5.5 | −4.8 MRR | **−11.0 MRR** | −5.6 |
| ms-marco-MiniLM · fuse | −0.6 | +2.7 | −4.1 | −4.1 MRR | −6.2 MRR | 0.0 |
| **bge-reranker-base · fuse** | **+2.9** | **+5.5** | −2.7 | **+5.2 MRR / +7.7 R@1** | **+7.7 R@1** | −11.1 (1 of 9) |
| bge-reranker-base · replace | −0.9 | −1.4 | −2.7 | +8.3 MRR | +2.2 MRR | **−36.9 MRR** |

**The winner: `bge-reranker-base` + `fuse` mode** — +2.9 MRR@10 / +5.5 R@1 overall,
and it helps the *exact* failure modes the Phase C eval was built to expose
(relational +7.7 R@1, ranked-low +7.7 R@1). Two non-negotiables: (1) the weak
`ms-marco-MiniLM` cross-encoder never wins — it misaligns with 3GPP normative text;
(2) `replace` mode tanks top-1 (it lets a noisy reranker fully override hybrid);
**`fuse` (RRF of reranker order ⊕ hybrid order) is essential** and protects top-1.

### Why it's HELD, not shipped (decision 2026-06-08)
- **Model size:** `bge-reranker-base` int8 ONNX = **266 MB** — >5× the whole 45 MB
  corpus, +244 MB over the dormant 22 MB ms-marco. Bundling it in the installer is
  disproportionate; a runtime-download delivery (like the corpus) is the right
  mechanism but is real implementation work.
- **Impl gap:** the shipped `reranker-ce.ts`/`retriever.ts` path does `replace`
  only. Enabling the win needs **fuse mode added** to the production rerank wiring.
- **Cost vs benefit today:** +5.5 R@1 is real but bought with a 266 MB model,
  ~1–2 s/query CPU latency, 1 top-1 demotion, and R@10 −2.7. Not worth it yet.

**Decision:** keep the reranker **dormant**; record the winning config here.
**Revisit when** a smaller strong reranker (e.g. a distilled/low-bit bge-reranker, or
a domain-tuned MiniLM-scale cross-encoder) lands, or when a runtime-download model
delivery is built. The 73-query set + `GROUP_BY=mode` make this a one-command re-gate.

Reproduce the win:
```bash
RERANK_MODEL=Xenova/bge-reranker-base RERANK_MODE=fuse GROUP_BY=mode \
  EXCLUDE_TEST_SPECS=1 node scripts/dev-rerank-eval.mjs
```
(n=73 is modest — treat as directional; re-confirm on a larger eval before shipping.)
