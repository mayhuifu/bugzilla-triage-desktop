# LLM Reranker (reuse AI Triage provider) — design

**Date:** 2026-06-08
**Repo:** bugzilla-triage-desktop **Branch:** `llm-reranker` (off `main`)
**Status:** Design approved; ready for implementation plan.

## Context

Hybrid retrieval (BM25 ⊕ dense ⊕ RRF) + conformance-test-spec demotion is the
shipped retrieval floor (v0.5.5): good recall, weak top-1. The cross-encoder
reranker was eval-gated and **HELD** — `bge-reranker-base` + fuse won (+2.9 MRR@10
/ +5.5 R@1 on the 73-query set, +7.7 R@1 on both relational and ranked-low) but
its model is 266 MB int8 (>5× the corpus), so we did not bundle it
(`EVAL-v0.5.5-reranker-findings.md` "Update 2026-06").

This feature gets that ranking win **without any bundled model** by reranking with
the **LLM the user already configured for AI Triage** (`lib/llm.ts` — providers:
`anthropic`, `openai-compatible`, `claude-cli`, `codex-cli`).

## Goal

A **listwise LLM reranker** for the `/spec` **search UI only**, turned on by an
**explicit button**, that lets users **compare hybrid vs LLM ranking** directly,
is **LLM-optional** (hybrid is the offline floor), leaves **triage untouched**,
and is **eval-gated** by a user-run harness before its default flips on.

## Non-goals (explicit)

- **No triage-path rerank.** In triage the LLM already receives the full top-K and
  reranks/cites implicitly; a second call there is marginal. `retrieveContextAsync`
  is not touched.
- **No bundled reranker model**, no corpus/schema change, no new corpus version.
- **No change to offline hybrid behavior** — no provider / toggle off ⇒ identical
  to today's hybrid (or BM25 fallback).
- **No new provider configuration** — reuse the existing triage provider/model/key.
- No deep refactor of the shipped triage code path.

## Mechanism — listwise + fuse

On a reranked search:
1. Hybrid RRF produces the top-K pool (`RERANK_CANDIDATE_K = 30`, existing const).
2. **One** LLM call ranks the pool: *"Given the query, rank these N clauses by
   relevance; return the indices best-first as a JSON array."* (Each candidate is
   presented as `[i] <parentTitle — title>. <text snippet>`, title-prefixed exactly
   like the cross-encoder passage, which is load-bearing for 3GPP acronym↔expansion.)
3. Parse the returned index order → assign descending scores (rank 1 → highest).
4. **RRF-fuse** the LLM order with the hybrid order (`1/(K+rank_llm) + 1/(K+rank_hybrid)`)
   → sort → return top-N.

**Why listwise:** one call (cheapest), and the LLM sees all candidates together
(better than independent pointwise scoring). **Why fuse, not replace:** the
cross-encoder eval showed `replace` mode tanks top-1 (−36.9 MRR / −55.6 R@1 for
bge-reranker-base); `fuse` protects top-1 and bounds a noisy/hallucinated LLM order.
This is the same fuse that produced the held cross-encoder win.

## Components (isolated, single-responsibility)

1. **`lib/llm.ts` → `runLlmText(system, user, opts)`** *(new, lean)*. A
   provider-agnostic *text → text* call mirroring the existing 4-way provider switch
   (`anthropic`/`openai` SDK direct; `claude-cli`/`codex-cli` via the existing
   Python sidecar). Deliberately **parallel** to the four `runTriage<Provider>`
   functions — the shipped triage path is **not** refactored, eliminating
   regression risk. Returns plain text; throws on hard provider failure (caller
   catches). `opts`: `{ model?, maxTokens?, timeoutMs? }`.
   - Interface: what it does = "ask the configured LLM a one-shot question, get
     text back"; depends on = settings + provider SDKs/sidecar; testable with a
     stubbed provider.
2. **`lib/corpus/reranker-llm.ts` → `LlmReranker implements CorpusReranker`**.
   `rerank(query, passages) → number[]`: builds the listwise prompt, calls
   `runLlmText`, parses the index order, returns rank→scores. **Never throws** —
   on timeout / malformed output / missing indices it returns the **original order**
   (identity scores), so the retriever silently keeps hybrid. `modelId =
   "llm:<provider>:<model>"`. Unranked/extra indices handled defensively.
3. **`lib/corpus/retriever.ts`** — two additive changes:
   - A pure **`fuseOrders(hybridIds, rerankedIds, k)`** helper (RRF of two orders)
     used by the rerank application. (Today's wiring does `replace`; `fuse` becomes
     the mode for the LLM path. The cross-encoder path is dormant; leave it.)
   - Thread a per-call **`rerank?: "llm"`** option through `retrieveByText` →
     `hybridRetrieve`. When set AND a provider is configured, build+use the
     `LlmReranker` with fuse for **that call only**. Triage callers never set it.
     Result `retrieverPath = "hybrid-rrf+llm-rerank"`; each result carries its
     `hybridRank` (pre-rerank position) so the UI can show the delta.
4. **`app/api/corpus/search/route.ts`** — accept `?rerank=llm`. Gate on a provider
   being configured (else ignore, return hybrid + a flag `rerankAvailable:false`).
   Return per-result `hybridRank` + `rerankRank` when reranked, and a top-level
   `ranking: "hybrid" | "llm"` echo.
5. **`/spec` search UI** — an explicit **ranking control**: two buttons
   **`Hybrid`** (default) and **`✨ AI rerank`**. The AI-rerank button is **disabled
   with a tooltip** ("Configure an AI provider in Settings") when no provider is set.
   Selecting `AI rerank` re-queries with `?rerank=llm`.
   - **Comparison:** each result card shows a **rank-delta badge** vs the hybrid
     baseline — `▲N` (moved up), `▼N` (down), `•` (unchanged), `★ new` (entered
     top-N from outside the hybrid top-N). Computed from `hybridRank` vs the
     displayed position. This is the "compare hybrid vs LLM" surface — toggle the
     button and watch results reorder with explainable deltas.
   - A small inline note while reranking ("Reranking with <provider>…") and a
     graceful "AI rerank unavailable, showing hybrid" state on fallback.
6. **`scripts/dev-llm-rerank-eval.mjs`** — dev harness (user-run; the agent's
   sandbox can't reach `api.anthropic.com`). Mirrors `dev-rerank-eval.mjs`: over the
   73-query eval set, fetch the hybrid pool, call the configured provider to listwise
   rerank, fuse, and report MRR@10 / R@1 / R@10 hybrid vs hybrid+LLM, per `mode`
   stratum (reusing the `GROUP_BY=mode` toggle), plus rescued/demoted counts — the
   same numbers that gated the cross-encoder, so the LLM reranker is judged on the
   same bar (vs hybrid, vs the held cross-encoder's +5.5 R@1).

## Data flow (search, rerank on)

```
search box query
  → GET /api/corpus/search?q=…&rerank=llm
    → retrieveByText(q, { rerank:"llm" })
      → hybridRetrieve: RRF pool top-30  ──hybrid order──┐
           │ provider configured?                        │
           ├─ no  → return hybrid (rerankAvailable:false)│
           └─ yes → LlmReranker.rerank(q, passages)      │
                      → runLlmText(rank prompt) → indices │
                      → fuseOrders(hybrid, llm) ──────────┘→ top-N (+hybridRank each)
  → UI renders reordered cards with ▲/▼/★ delta badges
```
Any failure in the LLM leg → `LlmReranker` returns original order → fuse is a no-op
→ hybrid results (badge shows all `•`), with the "unavailable" note.

## LLM-optional guarantee (load-bearing)

Rerank fires **only when (a provider is configured) AND (the AI-rerank button is
on)**. Offline / no-key / button-off search is **byte-identical to today's hybrid**
(or BM25 fallback). Triage retrieval never sets `rerank`. No code path makes search
*require* an LLM.

## Error handling

- `runLlmText` is **timeout-bounded** (`timeoutMs`, default ~10 s) so a slow/hung
  provider can't freeze search; on timeout it rejects → `LlmReranker` falls back.
- Malformed LLM output (non-JSON, wrong length, out-of-range/duplicate indices) →
  defensive parse keeps valid indices, appends the rest in hybrid order; if nothing
  parses, identity order.
- The search route always returns 200 with hybrid results on any rerank failure.

## Testing

No runtime test harness in-repo (matches the corpus repos' convention); validation is:
1. **`LlmReranker` unit-style check** with a **stubbed `runLlmText`** returning a
   known order → asserts scores reproduce that order, and malformed inputs fall back
   to identity. (A small `scripts/dev-llm-reranker-selfcheck.mjs` or inline.)
2. **`fuseOrders` check** — deterministic RRF fusion of two known orders.
3. **End-to-end:** `dev-llm-rerank-eval.mjs` (user-run) confirms the metric win.
4. **Manual:** `/spec` page — toggle AI rerank, confirm reorder + delta badges +
   disabled state with no provider + graceful fallback on a forced error.

## Acceptance criteria

1. With **no provider configured**, `/spec` search is unchanged hybrid; the AI-rerank
   button is disabled with the explanatory tooltip; `rerankAvailable:false`.
2. With a provider configured + AI-rerank on, results are LLM-reranked (fuse), each
   card shows a correct **▲/▼/•/★ delta** vs hybrid, `ranking:"llm"`.
3. **Triage is byte-unchanged** — no new LLM call, identical retrieved-clause set.
4. Forced LLM failure (bad key / timeout) → search returns **hybrid** results,
   never an error; UI shows the fallback note.
5. `runLlmText` works across all four providers (SDK direct + CLI sidecar) for a
   plain prompt; the shipped `runTriage` behavior is unchanged.
6. `dev-llm-rerank-eval.mjs` runs locally and prints hybrid-vs-LLM metrics per
   `mode` stratum on the 73-query set.
7. Ships with the AI-rerank default **OFF** (opt-in); no version-default flip until
   the harness confirms the win.

## Risks

- **CLI-provider plumbing.** `claude-cli`/`codex-cli` route through a triage-shaped
  Python sidecar; `runLlmText` needs a generic-prompt path through it. Mitigation:
  the plan reads `runTriageClaudeCli`/`runTriageCodexCli` first; if the sidecar is
  too triage-coupled, the first increment supports the **SDK providers** (anthropic /
  openai-compatible) and adds CLI in a follow-up (flagged, not silently dropped).
- **LLM latency/cost per reranked search.** Mitigation: default OFF, explicit button,
  timeout-bounded, one call per search; users opt in knowingly.
- **Non-determinism / hallucinated order.** Mitigation: fuse (can't fully override
  hybrid) + defensive parse + low/zero temperature in the rerank call.
- **Eval can't run in-sandbox** (API blocked). Mitigation: ship the harness for the
  user; default OFF until they confirm.
