import { NextResponse } from "next/server";
import {
  retrieveByText,
  lookupClause,
  activeRetrieverPath,
  type RetrievedClause,
} from "@/lib/corpus/retriever";
import { getCorpusDb, getClauseMediaFlags } from "@/lib/corpus/store";
import { hasConfiguredLlmProvider } from "@/lib/llm";
import { withUser } from "@/lib/users/with-user";
import { allowRate, rateEnv } from "@/lib/users/rate-limit";

export const dynamic = "force-dynamic";

/** Hybrid is "active" whether or not the cross-encoder rerank layer is on
 *  top (Phase A / v0.5.5 added "hybrid-rrf+rerank"). The UI badge keys off
 *  this bool; reranking is a refinement of the hybrid path, not a separate
 *  retrieval mode. */
function isHybrid(p: string): boolean {
  return p === "hybrid-rrf" || p === "hybrid-rrf+rerank" || p === "hybrid-rrf+llm-rerank";
}

// GET /api/corpus/search?q=<free text | citation>&limit=<N> — standalone
// 3GPP spec search backing the /spec workbench page (v0.5). NOT gated
// behind AI triage and needs no LLM: it runs the same hybrid (or BM25
// fallback) retrieval the triage prompt uses, over the local corpus.
//
// Query-shape detection:
//   - A citation ("TS 38.211 §7.4.2.2", "38.331 5.3.5") → direct
//     lookupClause jump, returned as a single result with kind:"citation".
//   - Anything else → free-text hybrid/BM25 retrieval, top-`limit` cards.
//
// Always 200 when the corpus is installed (empty `results` for no match);
// 200 with `corpusInstalled:false` when no corpus is downloaded yet (the
// page renders a "download the corpus" nudge rather than an error toast).
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** Heuristic: does the query look like a spec citation rather than free
 *  text? We accept the loose forms users actually type — "TS 38.211
 *  §7.4.2.2", "38.211 7.4.2.2", "TR 38.901 7.5". Requires a dotted spec
 *  number (NN.NNN, optional -N part) followed by a dotted clause number.
 *  Plain spec numbers with no clause (e.g. "38.211") are treated as free
 *  text so the search still returns that spec's top clauses. */
function looksLikeCitation(q: string): boolean {
  return /(?:TS|TR)?\s*\d{2}\.\d{3}(?:-\d+)?\s*(?:§|sec(?:tion)?|cl(?:ause)?|:|,|\s)+\s*\d+(?:\.\d+)+/i.test(q);
}

/** Trim each clause's text down to a search-card snippet so the JSON stays
 *  small. The drawer re-fetches full text via /api/corpus/lookup on open.
 *
 *  `media` is the batch-probed figure/table presence for this clause (the
 *  ranking path doesn't carry it). When provided it wins; otherwise we fall
 *  back to whatever inline arrays the clause already has (the citation-jump
 *  branch builds its card from a full lookupClause result, which does carry
 *  them). */
function toCard(
  c: RetrievedClause,
  media?: { hasFigures: boolean; hasTables: boolean },
) {
  const SNIPPET = 320;
  return {
    clauseId: c.clauseId,
    citation: c.citation,
    title: c.title,
    parentTitle: c.parentTitle,
    snippet: c.text.length > SNIPPET ? c.text.slice(0, SNIPPET).trimEnd() + "…" : c.text,
    score: c.bm25Score,
    retrieverPath: c.retrieverPath,
    matchedAs: c.matchedAs,
    hasFigures: media?.hasFigures ?? ((c.figureImages?.length ?? 0) > 0 || (c.figures?.length ?? 0) > 0),
    hasTables: media?.hasTables ?? ((c.tables?.length ?? 0) > 0),
  };
}

export const GET = withUser(async (req: Request) => {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const limitParam = parseInt(url.searchParams.get("limit") || "", 10);
  const limit = Number.isFinite(limitParam)
    ? Math.max(1, Math.min(limitParam, MAX_LIMIT))
    : DEFAULT_LIMIT;

  const corpusInstalled = !!getCorpusDb();
  const path = activeRetrieverPath(); // "none" | "bm25-v1" | "bm25-v2" | "hybrid-rrf"

  if (!q) {
    return NextResponse.json({
      query: "",
      kind: "empty",
      corpusInstalled,
      retrieverPath: path,
      hybridActive: isHybrid(path),
      rerankAvailable: hasConfiguredLlmProvider(),
      results: [],
    });
  }

  // Citation jump — single exact/ancestor result.
  if (looksLikeCitation(q)) {
    const hit = lookupClause(q);
    return NextResponse.json({
      query: q,
      kind: "citation",
      corpusInstalled,
      retrieverPath: path,
      hybridActive: isHybrid(path),
      rerankAvailable: hasConfiguredLlmProvider(),
      results: hit
        ? [{
            clauseId: hit.clauseId,
            citation: hit.citation,
            title: hit.title,
            parentTitle: hit.parentTitle,
            snippet: hit.text.length > 320 ? hit.text.slice(0, 320).trimEnd() + "…" : hit.text,
            matchedAs: hit.matchedAs,
            hasFigures: (hit.figureImages?.length ?? 0) > 0 || (hit.figures?.length ?? 0) > 0,
            hasTables: (hit.tables?.length ?? 0) > 0,
          }]
        : [],
    });
  }

  // Free-text retrieval. ?rerank=llm opts into LLM reranking, but ONLY when a
  // provider is configured — otherwise we silently stay hybrid (offline floor).
  const rerankAvailable = hasConfiguredLlmProvider();
  const wantLlm = url.searchParams.get("rerank") === "llm" && rerankAvailable;
  if (wantLlm && !allowRate("rerank", rateEnv("RATE_RERANK_PER_MIN", 20))) {
    return NextResponse.json(
      { error: "Rate limit: too many AI-reranked searches — try again in a minute." },
      { status: 429 },
    );
  }
  const results = await retrieveByText(q, { limit, ...(wantLlm ? { rerank: "llm" as const } : {}) });
  const mediaFlags = getClauseMediaFlags(results.map(r => r.clauseId));
  return NextResponse.json({
    query: q,
    kind: "text",
    corpusInstalled,
    retrieverPath: results[0]?.retrieverPath ?? path,
    hybridActive: isHybrid(results[0]?.retrieverPath ?? path),
    rerankAvailable,
    ranking: wantLlm ? "llm" : "hybrid",
    results: results.map((r, i) => ({
      ...toCard(r, mediaFlags.get(r.clauseId)),
      hybridRank: r.hybridRank,
      rank: i + 1,
    })),
  });
});
