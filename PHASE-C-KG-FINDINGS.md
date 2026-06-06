# Phase C (v0.5.7) — KG spike findings: DEFER the knowledge graph

> **Status:** Spike done, eval-gate FAILED → do not build the full KG yet.
> Durable hand-off (survives `/compact`). Plan: `PLAN-v0.5.7-knowledge-graph.md`.
> Spike: `scripts/dev-kg-spike.mjs`.

## TL;DR
A cheap, **no-LLM** KG spike (entities from the `acronyms` table, clause↔entity
links by matching acronyms + their spelled-out expansions, edges = shared-entity
+ clause hierarchy, RRF-fused with hybrid) **regressed** relational retrieval on
the eval: hybrid **5/6** acceptable clauses in top-10 → hybrid+kg **4/6**. Plus
hybrid already handles the current relational queries well (little headroom). So
there is **no measured case** to justify building the full KG (LLM entity/edge
extraction over ~13k clauses + schema v5 + runtime traversal). **Defer Phase C.**

## What the spike built (runs against rel17-v5, no LLM, no network)
- 152 entity nodes from `acronyms` (+ aliases). Clause↔entity links by matching
  the acronym token (case-sensitive, word-bounded) AND its ≥10-char expansion
  (case-insensitive) — so "Buffer Status Report" in a query maps to the BSR node.
  ~8 entities/clause.
- Edges: shared-entity (IDF-weighted) + clause-hierarchy siblings.
- Retrieval: hybrid RRF pool, then RRF-fuse with a KG-connection ranking
  (promotes pool clauses strong in the KG, pulls in connected clauses outside it).

## Result (3 relational eval queries, qid 86–88)
| query | acceptable | hybrid | +kg |
|---|---|---|---|
| 86 BSR↔SR | 38.321#5.4.5 / #5.4.4 | #11 / #3 | #13 / #2 |
| 87 PDCP↔RLC | 38.323#5.3 / 38.322#5.4 | #1 / #4 | #7 / #8 |
| 88 MAC↔RRC | 38.321#5.1.4 / 38.331#5.3.10.3 | #9 / #4 | #12 (dropped) / #6 |

**top-10 recall: hybrid 5/6 → hybrid+kg 4/6 (regression).**

## Why
1. **No headroom.** Hybrid already pulls both acceptable clauses into the pool
   (ranks 1–11) for these queries — there's no recall miss for graph traversal
   to recover. The KG can only re-rank, and the answer's already near the top.
2. **Co-occurrence edges are too noisy.** Common entities (MAC, RRC, UE, UL)
   link almost everything, so shared-entity expansion floods the candidate set
   with broadly-on-topic clauses and buries the specific answer. (The plan
   warned: "KG noise can hurt precision.")
3. **Eval too thin.** 3 synthetic relational queries can't establish the failure
   mode. The ones we have don't break hybrid, so they can't show a KG win.

## Recommendation
1. **Do NOT build the full KG now.** It's the most experimental + expensive phase
   (build-time LLM over 13k clauses — also network-blocked in this env) and the
   data shows no benefit; the cheap version actively hurts.
2. **Prerequisite first (same as every phase): harder eval.** Gather real
   relational/multi-hop queries where hybrid *demonstrably fails* to retrieve the
   multi-hop clause (a true recall miss, rank > pool). Only then can a KG show
   value. Source from real engineer questions, not synthetic pairs.
3. **If revisited:** prefer **LLM-extracted TYPED edges** (`configured_by`,
   `measured_by`, `depends_on`) which are selective, over co-occurrence which is
   noisy; and run the KG in **recall-recovery-only** mode (append clauses hybrid
   missed entirely; never re-rank/demote pool clauses) so it can't regress —
   gated on the harder eval. `dev-kg-spike.mjs` is the reusable gate.

## Cross-phase arc
- Phase A: reranker eval → regressed → shipped **test-spec demotion** instead (+8pp).
- Phase B: spec captions already indexed → **VLM optional**; shipped parser swap.
- Phase C: KG spike → regressed / no headroom → **defer**; need harder relational eval.

The hit-rank wins that actually landed were the cheap, eval-proven ones
(test-spec demotion, cleaner parse). The expensive add-ons (reranker, VLM, KG)
were each correctly gated OUT by the eval before sinking the build cost.

## Update 2026-06-06 — hard relational eval built; verdict holds (DEFER)
The prerequisite "harder eval" called for above is now built (corpus
HARD-RELATIONAL-EVAL.md + scripts/eval-queries-relational-candidates.json,
gate scripts/dev-relational-eval-gate.mjs). Of 26 grounded multi-hop queries,
only 3 are true recall-misses (answer outside the pool of 50 → KG territory);
7/10 hard cases are ranked-low-in-pool (reranker territory). Verdict unchanged:
DEFER the KG. Secondary finding: the reranker (shipped dormant) targets the
dominant hard mode — re-evaluating it against this harder set is likely higher
ROI than the KG. The 3 true-misses (eval qid 102,103,108) are the KG gate.
