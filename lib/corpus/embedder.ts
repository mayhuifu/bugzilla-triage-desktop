// ─────────────────────────────────────────────────────────────────
// lib/corpus/embedder.ts — pluggable query-time embedding hook.
//
// Corpus v2 carries dense vectors produced at build time by bge-m3
// (corpus repo SPEC.md §14 ADR-003). To do hybrid retrieval at query
// time we need a vector for the bug text in the SAME embedding space.
//
// The first-cut desktop release does NOT bundle an ONNX embedder —
// bge-m3 ONNX is ~570 MB which is too heavy for the installer, and
// any smaller open model produces vectors in a different space (so
// cosine similarity against bge-m3 build-time vectors is meaningless).
// Until the embedder bundling is resolved, the retriever's v2 path
// falls back to BM25-only over the wider v2 FTS5 index (which already
// includes parent_title + path, plus acronym expansion). That's still
// a measurable win over v1, just without the full hybrid lift.
//
// To plug in an embedder later (e.g. an ONNX Runtime sidecar, a
// remote API, or a Python child process), call setCorpusEmbedder()
// once at startup with an object implementing CorpusEmbedder. The
// retriever picks it up automatically on the next query.
// ─────────────────────────────────────────────────────────────────

import "server-only";

export interface CorpusEmbedder {
  /** Stable identifier of the model + variant, matched against
   *  meta.embeddingModel on the open corpus. Used to fail-fast when
   *  the bundled embedder doesn't match what the corpus was built with
   *  (otherwise cosine similarities would be silently meaningless). */
  readonly modelId: string;
  /** Compute the embedding for a bug-text query. The returned vector
   *  must be L2-normalised and have the dimension recorded in
   *  meta.embeddingDim. */
  embed(text: string): Promise<Float32Array>;
}

let _embedder: CorpusEmbedder | null = null;

/** Register a runtime embedder. Pass null to clear. Set once at app
 *  bootstrap — there is no hot-swap support; the retriever caches the
 *  reference per request. */
export function setCorpusEmbedder(embedder: CorpusEmbedder | null): void {
  _embedder = embedder;
}

export function getCorpusEmbedder(): CorpusEmbedder | null {
  return _embedder;
}
