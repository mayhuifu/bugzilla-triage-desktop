// ─────────────────────────────────────────────────────────────────
// lib/corpus/reranker.ts — pluggable cross-encoder reranker hook
// (next-gen RAG Phase A / v0.5.5).
//
// The hybrid retriever (BM25 ⊕ dense ⊕ RRF) has good recall but weak
// top-1: on the rel17-v5 build eval, hybrid raised R@10 0.31→0.46 but
// dropped R@1 0.13→0.08 — the right clause lands in the candidate set,
// just not first. A cross-encoder reranker reorders the candidate set by
// scoring each (query, clause) PAIR jointly (unlike the bi-encoder
// embedder, which scores them independently), which is exactly what fixes
// "ranked low".
//
// Same shape as embedder.ts: a small LOCAL ONNX (sequence-classification
// with a single relevance logit), NOT a generative LLM. Retrieval stays
// LLM-optional and offline — when no reranker is registered (older builds,
// load failure, or the model dir wasn't staged) the retriever returns the
// hybrid order unchanged. The reranker is a pure enhancement.
//
// Register once at startup via setCorpusReranker(); the retriever picks it
// up on the next query. Mirrors setCorpusEmbedder() deliberately.
// ─────────────────────────────────────────────────────────────────

import "server-only";

export interface CorpusReranker {
  /** Stable identifier of the model + variant, for /api/corpus/status
   *  reporting and debug surfaces. Unlike the embedder's modelId this is
   *  NOT matched against any corpus meta field — the reranker scores raw
   *  (query, text) pairs and needs no shared embedding space, so it works
   *  against any corpus version. */
  readonly modelId: string;
  /** Score the relevance of each passage to the query. Returns one score
   *  per passage, same order as the input; HIGHER = more relevant. Scores
   *  are only meaningful for RANKING (relative order), not as calibrated
   *  probabilities — the caller sorts by them and keeps the top-N. Must
   *  not throw for the empty array (returns []). */
  rerank(query: string, passages: string[]): Promise<number[]>;
}

let _reranker: CorpusReranker | null = null;

/** Register a runtime reranker. Pass null to clear. Set once at app
 *  bootstrap — there is no hot-swap support; the retriever reads the
 *  reference per request. */
export function setCorpusReranker(reranker: CorpusReranker | null): void {
  _reranker = reranker;
}

export function getCorpusReranker(): CorpusReranker | null {
  return _reranker;
}
