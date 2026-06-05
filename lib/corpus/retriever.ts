// ─────────────────────────────────────────────────────────────────
// lib/corpus/retriever.ts — pre-triage retrieval over the local 3GPP
// corpus + post-triage exact-clause lookup. Backs the AI triage prompt
// with concrete spec text.
//
// Two entry points:
//
//   retrieveContext(ticket) → top-K candidate clauses for prompt injection.
//                             Path chosen by `corpus.sqlite` schemaVersion
//                             (see SPEC.md §14 in the corpus repo):
//
//     • v1 corpus  → original OR-of-terms BM25 over (citation, title, text).
//     • v2 corpus  → acronym-expanded query over the wider FTS5 index
//                    (citation, title, parent_title, path, text). Optional
//                    hybrid RRF (BM25 ⊕ sqlite-vec cosine) when a query
//                    embedder is registered via setCorpusEmbedder() and the
//                    embedder.modelId matches the corpus's meta.embeddingModel.
//
//   lookupClause(citation) → exact PK lookup unchanged across versions.
//
// Both no-op when the corpus isn't installed.
// ─────────────────────────────────────────────────────────────────

import "server-only";
import type { TicketDetail } from "../types";
import { corpusHasVectors, getCorpusDb, getFigureImagesForClause } from "./store";
import { expandAcronyms } from "./acronyms";
import { getCorpusEmbedder } from "./embedder";
import { ensureBgeEmbedderRegistered } from "./embedder-bge";
import { getCorpusReranker, type CorpusReranker } from "./reranker";
import { ensureRerankerRegistered } from "./reranker-ce";

/** Structured table lifted from the v2 corpus's `tables_json` column.
 *  The corpus pipeline (bugzilla-triage-corpus 02-parse.ts) extracts these
 *  during parsing — alongside the flattened pipe-separated text the FTS
 *  index sees — so the desktop renderer can show real <table>s instead
 *  of walls of pipes. v1 corpora don't carry this. */
export interface ClauseTable {
  id: string;
  caption: string;
  rows: string[][];
}

export interface ClauseFigure {
  id: string;
  caption: string;
  /** Source media filename inside the build (Phase 1 / schemaVersion=3
   *  only). When present and the corpus carries the `figure_images`
   *  table, the desktop renders the image inline in the SpecDrawer
   *  via `/api/corpus/figure?clauseId=…&figureId=…`. Older corpora
   *  (v1/v2) don't populate this field — figures still show their
   *  captions, just no image. */
  mediaFilename?: string;
  /** VLM-generated content caption (corpus rel17-v6 / schemaVersion=4). A
   *  concise factual description of what the diagram SHOWS, generated at
   *  build time and also folded into the clause's indexed/embedded text so
   *  the figure is searchable by content. Absent on v1–v3 corpora. */
  vlmCaption?: string;
}

/** Lightweight figure-image metadata attached to a lookupClause result
 *  when the corpus has the v3 `figure_images` table populated. The
 *  blob itself is NOT inlined — clients fetch it via the
 *  `/api/corpus/figure?…` endpoint to keep JSON responses lean. */
export interface ClauseFigureImage {
  /** Composite identifier used as the URL fragment to fetch the blob.
   *  Matches the `figure_images.figure_id` column in the SQLite. */
  figureId: string;
  /** Canonical IANA MIME type: image/svg+xml | image/png | image/jpeg | image/gif. */
  mimeType: string;
  bytes: number;
}

export interface RetrievedClause {
  clauseId: string;          // canonical id, e.g. "38.211#6.1.4"
  citation: string;          // human-readable, e.g. "3GPP TS 38.211 §6.1.4"
  title: string;
  parentTitle?: string;
  text: string;              // full clause text (capped for prompt injection)
  bm25Score?: number;        // negative number; lower (more negative) = better
  /** Cross-encoder reranker score (Phase A / v0.5.5). Present only on
   *  results returned by the "hybrid-rrf+rerank" path; HIGHER = more
   *  relevant. Used for the debug surface and to expose why ordering
   *  differs from the raw RRF fusion. */
  rerankScore?: number;
  /** Retrieval source label for the SpecDrawer / debug surface. */
  retrieverPath?: "bm25-v1" | "bm25-v2" | "hybrid-rrf" | "hybrid-rrf+rerank";
  /** Structured tables (v2 only). Empty array on v1 corpora. */
  tables?: ClauseTable[];
  /** Figure references (v2 only). */
  figures?: ClauseFigure[];
  /** Figure images stored in the v3 `figure_images` table — one entry
   *  per renderable image attached to the clause. Empty array on
   *  v1/v2 corpora (or v3 corpora where the clause has no images).
   *  Blob bytes are NOT inlined here; clients fetch via the
   *  `/api/corpus/figure?…` endpoint. */
  figureImages?: ClauseFigureImage[];
  /** Whether the lookup hit the exact cited clause id, or fell back to
   *  the closest descendant leaf because the cited id was a non-leaf
   *  parent section. UI shows a hint when "ancestor". */
  matchedAs?: "exact" | "ancestor";
  /** Populated only when `matchedAs === "ancestor"`: the parent id the
   *  user / model cited, which the lookup couldn't satisfy directly. */
  requestedClauseId?: string;
}

const TOP_K = 4;
const MAX_TEXT_CHARS = 1200; // per-clause cap when injecting into prompt

// Hybrid retrieval constants — mirrored from the corpus pipeline so the
// runtime behaviour matches what 05-eval.ts measures at build time.
const RRF_K = 60;
const CANDIDATES_PER_SOURCE = 50;

// Reranker constants (Phase A / v0.5.5). When a cross-encoder reranker is
// registered, the hybrid path generates a WIDER candidate pool (so the
// reranker has something to reorder) and returns the top `limit` after
// reranking. RERANK_CANDIDATE_K is the pool size; raising it improves the
// chance the right clause is in the pool at the cost of more cross-encoder
// forward passes (each ~constant). 30 matched the eval sweet spot.
const RERANK_CANDIDATE_K = 30;
// The query side of a cross-encoder pair shares the model's 512-token budget
// with the passage, so a long ticket description would crowd out the clause
// text. Cap the rerank query to keep the passage well-represented.
const RERANK_QUERY_MAX_CHARS = 512;

// ── Conformance-test-spec demotion (v0.5.5) ───────────────────────
//
// The biggest measured hit-rank win. The corpus carries 3GPP conformance
// TEST specs (38.523-1, 38.521-*, 38.508-1, 36.523-1, 36.521-*, 36.508)
// alongside the normative specs. Their test-procedure clauses share heavy
// vocabulary with bug summaries ("the UE shall …", procedure names) and so
// FLOOD the candidate pool, burying the normative clause an engineer actually
// wants. On the rel17-v5 + 48-query eval, demoting them below normative
// clauses lifted R@1 10.4%→18.8% (+8.4pp) and MRR@10 19.7→27.2 (+7.5pp) with
// R@10 unchanged — i.e. the right answers were always retrieved, just buried.
// See EVAL-v0.5.5-reranker-findings.md.
//
// Strategy: a STABLE PARTITION — normative clauses keep their retrieved order,
// then test-spec clauses follow (also in order). Test specs still appear (the
// product intent: they were curated in deliberately), just below normative
// clauses. Equivalent to a strong soft penalty (penalty 0…0.5 all collapsed to
// the same eval numbers). Applied as the FINAL ranking step so it holds
// regardless of bm25 vs hybrid vs rerank. Disable with CORPUS_DEMOTE_TEST_SPECS=0.
const DEMOTE_TEST_SPECS = process.env.CORPUS_DEMOTE_TEST_SPECS !== "0";
// Match the spec base of each conformance test series (also matches -N parts:
// 38.521-1/-2/-3 etc.). Anchored at start of the spec token.
const TEST_SPEC_RE = /^(?:38\.523|36\.523|38\.521|36\.521|38\.508|36\.508)\b/;
// When demoting, fetch a WIDER candidate pool than `limit` so normative
// clauses ranked just outside the window can bubble up past demoted test
// specs. Without this, a top-`limit` already full of test specs has nothing
// to promote in their place.
const DEMOTE_POOL_MIN = 50;

function isTestSpecId(clauseId: string): boolean {
  return TEST_SPEC_RE.test(clauseId.split("#")[0]);
}

/** Stable partition: normative clauses first (retrieved order preserved),
 *  then test-spec clauses (retrieved order preserved). No-op on corpora
 *  without test specs (v1) or when CORPUS_DEMOTE_TEST_SPECS=0. */
function demoteTestSpecs(clauses: RetrievedClause[]): RetrievedClause[] {
  if (!DEMOTE_TEST_SPECS) return clauses;
  const normative: RetrievedClause[] = [];
  const test: RetrievedClause[] = [];
  for (const c of clauses) (isTestSpecId(c.clauseId) ? test : normative).push(c);
  return test.length === 0 ? clauses : normative.concat(test);
}

/** Candidate-pool size to fetch before demotion + slicing to `limit`. */
function demotePoolSize(limit: number): number {
  return DEMOTE_TEST_SPECS ? Math.max(DEMOTE_POOL_MIN, limit * 5, limit) : limit;
}

// Common English stopwords that confuse BM25 ranking when bag-of-words.
const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "when", "have",
  "been", "are", "was", "were", "will", "into", "but", "not", "you",
  "your", "our", "their", "its", "his", "her", "him", "she", "all",
  "any", "can", "had", "has", "may", "off", "out", "than", "then",
]);

// Words that signal NR-vs-LTE so we can bias retrieval toward the
// right spec series. Lowercase keys; values are spec-prefix hints
// passed into the FTS MATCH expression as additional weighted terms.
const NR_HINTS = ["nr", "5g", "rnti", "bwp", "prb", "redcap"];
const LTE_HINTS = ["lte", "e-utra", "eutra", "epc", "rlc-um"];

interface QueryShape {
  /** Final OR-of-terms FTS5 MATCH expression. */
  match: string;
  /** Tokens used to build `match` — kept for debug surfaces. */
  tokens: string[];
}

/** Tokenise an arbitrary blob into BM25-friendly content terms: lowercase,
 *  punctuation-stripped, stopword-filtered, deduplicated. Shared by the
 *  ticket path (tokenizeTicket) and the raw-query path (buildQueryFromText)
 *  so /spec search and AI-triage retrieval tokenise identically. */
function tokenizeText(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(t => t.length >= 3 && t.length <= 32)
    .filter(t => !STOPWORDS.has(t));
  return Array.from(new Set(tokens));
}

function tokenizeTicket(ticket: TicketDetail): string[] {
  const parts: string[] = [
    ticket.summary,
    ticket.description.slice(0, 2000),
    ticket.component,
    ...(ticket.keywords ?? []),
    ...ticket.comments.slice(1, 3).map(c => c.text.slice(0, 800)),
  ];
  return tokenizeText(parts.join(" "));
}

function applyNrLteBias(tokens: string[], blob: string): string[] {
  const isNr = NR_HINTS.some(h => blob.includes(h));
  const isLte = LTE_HINTS.some(h => blob.includes(h));
  if (isNr && !isLte) return [...tokens, "nr", "nr"];
  if (isLte && !isNr) return [...tokens, "lte", "lte"];
  return tokens;
}

function buildQuery(ticket: TicketDetail, useAcronymExpansion: boolean): QueryShape {
  const baseTokens = tokenizeTicket(ticket);
  const expanded = useAcronymExpansion ? expandAcronyms(baseTokens) : baseTokens;
  const blob = `${ticket.summary} ${ticket.description}`.toLowerCase();
  const biased = applyNrLteBias(expanded, blob);
  const uniq = Array.from(new Set(biased)).slice(0, 60);
  // FTS5 MATCH default is AND across bare terms, which empirically returns
  // zero hits on real ticket text. Explicit OR gives recall-over-precision
  // behaviour; BM25 then ranks by which doc covers more terms.
  const match = uniq.length === 0 ? '""' : uniq.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");
  return { match, tokens: uniq };
}

/** Build an FTS5 query from a free-text string (the /spec search box, or a
 *  ticket summary handed to "Research in 3GPP"). Same acronym-expansion +
 *  NR/LTE bias the ticket path uses, but driven by one blob instead of the
 *  structured ticket fields. */
function buildQueryFromText(text: string, useAcronymExpansion: boolean): QueryShape {
  const baseTokens = tokenizeText(text);
  const expanded = useAcronymExpansion ? expandAcronyms(baseTokens) : baseTokens;
  const biased = applyNrLteBias(expanded, text.toLowerCase());
  const uniq = Array.from(new Set(biased)).slice(0, 60);
  const match = uniq.length === 0 ? '""' : uniq.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");
  return { match, tokens: uniq };
}

/** Read meta.embeddingModel from the corpus once (cached for the process). */
let _embedModelChecked = false;
let _embedModelInCorpus: string | null = null;
function corpusEmbeddingModel(): string | null {
  if (_embedModelChecked) return _embedModelInCorpus;
  _embedModelChecked = true;
  const db = getCorpusDb();
  if (!db) return null;
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='embeddingModel'").get() as { value?: string } | undefined;
    _embedModelInCorpus = row?.value ?? null;
  } catch {
    _embedModelInCorpus = null;
  }
  return _embedModelInCorpus;
}

/** Resolve which retrieval path to use against the open corpus. */
function decidePath(): "bm25-v1" | "bm25-v2" | "hybrid-rrf" {
  const db = getCorpusDb();
  if (!db) return "bm25-v1";
  let schemaVersion: string | undefined;
  try {
    schemaVersion = (db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get() as { value?: string } | undefined)?.value;
  } catch { /* meta read failed → treat as v1 */ }
  if (!schemaVersion || schemaVersion.startsWith("1")) return "bm25-v1";

  // v2 corpus. Use hybrid only when sqlite-vec is loaded AND a query
  // embedder has been registered AND its model matches the corpus's
  // build-time model. Otherwise fall back to the wider-FTS5 BM25 path.
  if (!corpusHasVectors()) return "bm25-v2";
  // Lazily register the bundled bge embedder on first need (idempotent).
  // Done here rather than via instrumentation.ts because this module is
  // node-only; instrumentation is also edge-compiled, where the embedder's
  // node:fs / onnxruntime-node deps can't resolve.
  ensureBgeEmbedderRegistered();
  const embedder = getCorpusEmbedder();
  if (!embedder) return "bm25-v2";
  const corpusModel = corpusEmbeddingModel();
  if (corpusModel && embedder.modelId !== corpusModel) {
    // eslint-disable-next-line no-console
    console.warn(`[corpus] embedder model '${embedder.modelId}' does not match corpus '${corpusModel}'; falling back to BM25`);
    return "bm25-v2";
  }
  return "hybrid-rrf";
}

function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Ensure the bundled cross-encoder reranker is registered (idempotent) and
 *  return it, or null if registration failed / no model is available. The
 *  reranker works against any corpus version (it scores raw text pairs, no
 *  embedding-space match required), so unlike the embedder there is no
 *  meta.embeddingModel gate. */
function getActiveReranker(): CorpusReranker | null {
  ensureRerankerRegistered();
  return getCorpusReranker();
}

/** Build the passage string handed to the cross-encoder for a candidate.
 *  The clause TITLE (and parent title) is load-bearing: 3GPP bodies
 *  abbreviate to acronyms the title spells out (e.g. body "PDSCH" vs title
 *  "Physical downlink shared channel"), and a general MS-MARCO cross-encoder
 *  bridges that gap far better when the expansion is present. Verified in
 *  scripts/spike-reranker.mjs (case 3 flipped from miss to hit once the
 *  title prefix was added). */
function rerankPassage(c: RetrievedClause): string {
  const head = c.parentTitle ? `${c.parentTitle} — ${c.title}` : c.title;
  return `${head}. ${c.text}`;
}

interface CandidateRow {
  id: string; spec: string; clause_no: string; citation: string;
  title: string; parent_title: string | null; text: string;
  score?: number;
}

function mapRows(rows: CandidateRow[], path: RetrievedClause["retrieverPath"]): RetrievedClause[] {
  return rows.map(r => ({
    clauseId: r.id,
    citation: r.citation,
    title: r.title,
    parentTitle: r.parent_title ?? undefined,
    text: r.text.length > MAX_TEXT_CHARS ? r.text.slice(0, MAX_TEXT_CHARS) + "…" : r.text,
    bm25Score: r.score,
    retrieverPath: path,
  }));
}

/** Synchronous BM25 path used by both v1 and v2 (the SQL differs only in
 *  which FTS columns the underlying tokenize+rank operates over, which is
 *  baked into the FTS5 virtual table at build time). */
function bm25Retrieve(matchExpr: string, label: "bm25-v1" | "bm25-v2", limit: number = TOP_K): RetrievedClause[] {
  const db = getCorpusDb();
  if (!db) return [];
  try {
    // Fetch a wider pool so test-spec demotion can promote normative clauses
    // ranked just outside `limit` (no-op slice when demotion is off).
    const fetchN = demotePoolSize(limit);
    const rows = db.prepare(`
      SELECT c.id, c.spec, c.clause_no, c.citation, c.title, c.parent_title, c.text,
             bm25(clauses_fts) AS score
      FROM clauses_fts
      JOIN clauses c ON c.rowid = clauses_fts.rowid
      WHERE clauses_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(matchExpr, fetchN) as CandidateRow[];
    return demoteTestSpecs(mapRows(rows, label)).slice(0, limit);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[corpus] ${label} retrieval failed:`, err);
    return [];
  }
}

/** Hybrid RRF path, optionally followed by cross-encoder reranking
 *  (Phase A / v0.5.5). Returns empty array on any failure so the caller can
 *  fall through to BM25 — never throws.
 *
 *  When a reranker is registered, the RRF fusion produces a WIDER candidate
 *  pool (RERANK_CANDIDATE_K) which the cross-encoder reorders by scoring each
 *  (rerankQuery, clause) pair jointly; the top `limit` after reranking is
 *  returned with retrieverPath="hybrid-rrf+rerank". Without a reranker the
 *  behaviour is unchanged: top `limit` of the RRF order, "hybrid-rrf".
 *
 *  `rerankQuery` is a CONCISE natural-language query (e.g. a ticket summary
 *  or the search box text) — distinct from `queryText`, which is embedded and
 *  may be long. The cross-encoder shares a 512-token budget between query and
 *  passage, so a long query would crowd out the clause text. */
async function hybridRetrieve(
  matchExpr: string,
  queryText: string,
  limit: number = TOP_K,
  rerankQuery?: string,
): Promise<RetrievedClause[]> {
  const db = getCorpusDb();
  const embedder = getCorpusEmbedder();
  if (!db || !embedder) return [];
  let vec: Float32Array;
  try {
    vec = await embedder.embed(queryText);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[corpus] embedder.embed failed; falling back to BM25:`, err);
    return [];
  }
  const reranker = getActiveReranker();
  // Fetch a wider pool than `limit`: enough for the rerank window (when on)
  // AND for test-spec demotion to bubble normative clauses up past demoted
  // test specs. Both default to ≥50, so the RRF fusion always sees a healthy
  // candidate set.
  const wanted = Math.max(reranker ? RERANK_CANDIDATE_K : 0, demotePoolSize(limit));
  // Each source must surface at least `wanted` candidates so the RRF fusion
  // has enough to rank — widen the per-source cap accordingly.
  const perSource = Math.max(CANDIDATES_PER_SOURCE, wanted);
  let candidates: RetrievedClause[];
  try {
    const rows = db.prepare(`
      WITH fts_top AS (
        SELECT c.rowid AS rowid,
               ROW_NUMBER() OVER (ORDER BY bm25(clauses_fts)) AS rk
        FROM clauses_fts
        JOIN clauses c ON c.rowid = clauses_fts.rowid
        WHERE clauses_fts MATCH ?
        LIMIT ?
      ),
      vec_top AS (
        SELECT rowid,
               ROW_NUMBER() OVER (ORDER BY distance) AS rk
        FROM clauses_vec
        WHERE embedding MATCH ? AND k = ?
      ),
      fused AS (
        SELECT rowid, SUM(1.0 / (? + rk)) AS rrf_score
        FROM (SELECT rowid, rk FROM fts_top UNION ALL SELECT rowid, rk FROM vec_top)
        GROUP BY rowid
      )
      SELECT c.id, c.spec, c.clause_no, c.citation, c.title, c.parent_title, c.text,
             fused.rrf_score AS score
      FROM fused
      JOIN clauses c ON c.rowid = fused.rowid
      ORDER BY fused.rrf_score DESC
      LIMIT ?
    `).all(
      matchExpr, perSource,
      vecToBlob(vec), perSource,
      RRF_K, wanted,
    ) as CandidateRow[];
    candidates = mapRows(rows, "hybrid-rrf");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[corpus] hybrid retrieval failed:`, err);
    return [];
  }

  // No reranker (default) → demote test specs as the final ranking step,
  // return top `limit`. This is the v0.5.5 hit-rank win (+8pp R@1).
  if (!reranker || candidates.length <= 1) {
    return demoteTestSpecs(candidates).slice(0, limit);
  }

  // Cross-encoder rerank (opt-in, CORPUS_RERANK=1; OFF by default — the eval
  // showed it regresses, see EVAL-v0.5.5-reranker-findings.md). Rerank the
  // top-K window, keep the remaining pool after it, THEN demote test specs as
  // the final step so the demotion invariant holds regardless of rerank. The
  // query is the concise rerankQuery (capped) so the passage isn't crowded out
  // of the 512-token budget.
  const rq = (rerankQuery ?? queryText).slice(0, RERANK_QUERY_MAX_CHARS);
  try {
    const window = candidates.slice(0, RERANK_CANDIDATE_K);
    const rest = candidates.slice(RERANK_CANDIDATE_K);
    const scores = await reranker.rerank(rq, window.map(rerankPassage));
    const reranked = window
      .map((c, i) => ({ ...c, retrieverPath: "hybrid-rrf+rerank" as const, rerankScore: Number.isFinite(scores[i]) ? scores[i] : -Infinity }))
      .sort((a, b) => (b.rerankScore as number) - (a.rerankScore as number));
    return demoteTestSpecs([...reranked, ...rest]).slice(0, limit);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[corpus] rerank failed; using hybrid order:`, err);
    return demoteTestSpecs(candidates).slice(0, limit);
  }
}

/** Synchronous-by-default top-K retrieval. When the v2 hybrid path is
 *  available the caller can opt into the async overload via
 *  retrieveContextAsync(). Retained as sync because the existing
 *  call sites (lib/llm.ts, app/api/.../triage) are sync.
 *
 *  Sync calls on a v2 corpus with a registered embedder still degrade
 *  to BM25 — dense embedding requires async. Switch to the async API
 *  to unlock hybrid. */
export function retrieveContext(ticket: TicketDetail): RetrievedClause[] {
  const path = decidePath();
  if (path === "hybrid-rrf") {
    // sync caller: degrade to v2 BM25 — pleasant because v2 already
    // widens the FTS5 index and we still get acronym expansion.
    const q = buildQuery(ticket, /*useAcronymExpansion=*/ true);
    return bm25Retrieve(q.match, "bm25-v2");
  }
  if (path === "bm25-v2") {
    const q = buildQuery(ticket, /*useAcronymExpansion=*/ true);
    return bm25Retrieve(q.match, "bm25-v2");
  }
  const q = buildQuery(ticket, /*useAcronymExpansion=*/ false);
  return bm25Retrieve(q.match, "bm25-v1");
}

/** Async overload — preferred when the host is willing to await. Uses
 *  the hybrid CTE when available, falling back through BM25-v2 / BM25-v1
 *  on any error. */
export async function retrieveContextAsync(ticket: TicketDetail): Promise<RetrievedClause[]> {
  const path = decidePath();
  if (path === "hybrid-rrf") {
    const q = buildQuery(ticket, /*useAcronymExpansion=*/ true);
    const queryText = [
      ticket.summary,
      ticket.description.slice(0, 2000),
      ticket.component ?? "",
    ].join("\n");
    // Concise query for the cross-encoder (the summary is the highest-signal
    // line; the long description is for the embedder, not the reranker).
    const rerankQuery = [ticket.summary, ticket.component]
      .filter(Boolean)
      .join(" — ");
    const hits = await hybridRetrieve(q.match, queryText, TOP_K, rerankQuery);
    if (hits.length > 0) return hits;
    // Fall through on empty / error.
    return bm25Retrieve(q.match, "bm25-v2");
  }
  return retrieveContext(ticket);
}

export interface RetrieveByTextOptions {
  /** How many ranked clauses to return. Clamped to [1, 50]. Defaults to
   *  TOP_K (the prompt-injection budget); the /spec search list passes a
   *  larger value. */
  limit?: number;
}

/** Free-text retrieval — the standalone-search counterpart to
 *  retrieveContextAsync(ticket). Takes a raw query string (the /spec search
 *  box, or a ticket summary forwarded from "Research in 3GPP") instead of a
 *  structured TicketDetail, and returns the top-`limit` ranked clauses.
 *
 *  Path selection mirrors the ticket path exactly (decidePath()): hybrid
 *  RRF when a matching embedder is registered, else the wider-FTS5 BM25-v2
 *  path, else the v1 BM25 path. Never throws — every failure mode degrades
 *  to a narrower path or an empty array, so the search UI can render a
 *  graceful "no results" instead of an error. */
export async function retrieveByText(
  query: string,
  opts: RetrieveByTextOptions = {},
): Promise<RetrievedClause[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? TOP_K, 50));
  const path = decidePath();
  if (path === "hybrid-rrf") {
    const q = buildQueryFromText(trimmed, /*useAcronymExpansion=*/ true);
    // The search-box text is already concise — reuse it as the rerank query.
    const hits = await hybridRetrieve(q.match, trimmed, limit, trimmed);
    if (hits.length > 0) return hits;
    return bm25Retrieve(q.match, "bm25-v2", limit);
  }
  if (path === "bm25-v2") {
    const q = buildQueryFromText(trimmed, /*useAcronymExpansion=*/ true);
    return bm25Retrieve(q.match, "bm25-v2", limit);
  }
  const q = buildQueryFromText(trimmed, /*useAcronymExpansion=*/ false);
  return bm25Retrieve(q.match, "bm25-v1", limit);
}

/** Which retrieval strategy the open corpus would use right now. Returns
 *  "none" when no corpus is installed. Lets /api/corpus/search and
 *  /api/corpus/status report `hybridActive` to the UI (and surfaces the
 *  silent BM25-fallback-on-model-mismatch case, which is otherwise
 *  invisible). */
export function activeRetrieverPath(): "bm25-v1" | "bm25-v2" | "hybrid-rrf" | "hybrid-rrf+rerank" | "none" {
  if (!getCorpusDb()) return "none";
  const path = decidePath();
  // The reranker layers on top of the hybrid path only (Phase A scope). When
  // hybrid is active AND a reranker is registered, the live path reranks.
  if (path === "hybrid-rrf" && getActiveReranker()) return "hybrid-rrf+rerank";
  return path;
}

/** Parse a model-emitted citation string into our canonical clause id.
 *  Tolerant of the various forms the model might produce.
 *
 *  The clause-number capture allows dot-separated ALPHANUMERIC segments,
 *  not just digits, because 3GPP clause numbers carry letters in several
 *  places: Annex clauses lead with a letter (`F.5.1`, `A.7.5.6`), and some
 *  amended clauses embed letters mid-string (`8.6.2A.1`) or as a suffix
 *  (`8.6C`). The old `[\d.]+` pattern silently failed to match any of
 *  these, so a search result for an Annex clause would render in the list
 *  but 404 in the drawer ("clause not found in corpus") even though the
 *  clause is present — the citation simply never parsed back into its id. */
function parseCitation(reference: string): { spec: string; clauseNo: string } | null {
  const m = reference.match(/(?:TS|TR)\s+(\d+\.\d+(?:-\d+)?)\s*(?:§|sec(?:tion)?|cl(?:ause)?|:|,|\.|\s)+\s*([A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)/i);
  if (!m) return null;
  return { spec: m[1], clauseNo: m[2].replace(/\.$/, "") };
}

export function lookupClause(reference: string): RetrievedClause | null {
  const db = getCorpusDb();
  if (!db) return null;
  const parsed = parseCitation(reference);
  if (!parsed) return null;
  const id = `${parsed.spec}#${parsed.clauseNo}`;
  try {
    // v2 adds tables_json + figures_json columns. Read them with COALESCE
    // so this same query works against v1 corpora too (where the columns
    // are absent — SQLite would error on a bare SELECT of a missing column).
    // We resolve the schema once per process.
    const hasV2Cols = corpusHasV2Columns(db);
    interface V1Row { id: string; citation: string; title: string; parent_title: string | null; text: string; }
    interface V2Row extends V1Row { tables_json: string; figures_json: string; }
    const selectExact = hasV2Cols
      ? db.prepare(`
          SELECT id, citation, title, parent_title, text,
                 COALESCE(tables_json, '[]')  AS tables_json,
                 COALESCE(figures_json, '[]') AS figures_json
          FROM clauses WHERE id = ?
        `)
      : db.prepare(`
          SELECT id, citation, title, parent_title, text
          FROM clauses WHERE id = ?
        `);
    // Exact PK match first.
    let row = selectExact.get(id) as V1Row | V2Row | undefined;
    let matchedAs: "exact" | "ancestor" = "exact";

    // Ancestor fallback: models tend to cite at section level (e.g.
    // "TS 38.331 §5.3.5") but the corpus only holds LEAF clauses
    // (5.3.5.1, 5.3.5.2, …). Without this fallback the lookup returns
    // null for those citations, the UI's "View clause" button stays
    // hidden, and the model's reference looks useless to the user.
    // Resolve to the lexically smallest leaf under the cited prefix —
    // typically the "general" / index sub-clause that introduces the
    // section. Use lexical ordering of dotted-number ids; that orders
    // 5.3.5.1 < 5.3.5.10 < 5.3.5.2, which is wrong arithmetically but
    // the FIRST leaf is what we want, so it's fine (we'd always pick
    // 5.3.5.1 over 5.3.5.10 even in arithmetic order).
    if (!row) {
      const selectAncestor = hasV2Cols
        ? db.prepare(`
            SELECT id, citation, title, parent_title, text,
                   COALESCE(tables_json, '[]')  AS tables_json,
                   COALESCE(figures_json, '[]') AS figures_json
            FROM clauses
            WHERE id LIKE ? ESCAPE '\\'
            ORDER BY id
            LIMIT 1
          `)
        : db.prepare(`
            SELECT id, citation, title, parent_title, text
            FROM clauses
            WHERE id LIKE ? ESCAPE '\\'
            ORDER BY id
            LIMIT 1
          `);
      // LIKE pattern: literal `<spec>#<clauseNo>.%`. The % only matches
      // after a literal dot, so we don't pick up siblings like
      // `5.3.50.x` when the cited prefix was `5.3.5`.
      const escaped = id.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
      row = selectAncestor.get(`${escaped}.%`) as V1Row | V2Row | undefined;
      if (row) matchedAs = "ancestor";
    }
    if (!row) return null;
    const v2row = hasV2Cols ? (row as V2Row) : null;
    // v3 figure images — listed cheaply (metadata-only, no blobs in JSON
    // response). Returns [] silently for v1/v2 corpora and for clauses
    // whose figures didn't pair with any media file during parse.
    const figureImages = getFigureImagesForClause(row.id).map(m => ({
      figureId: m.figureId,
      mimeType: m.mimeType,
      bytes: m.bytes,
    }));
    return {
      clauseId: row.id,
      citation: row.citation,
      title: row.title,
      parentTitle: row.parent_title ?? undefined,
      text: row.text,
      tables: v2row ? safeJsonArray<ClauseTable>(v2row.tables_json) : [],
      figures: v2row ? safeJsonArray<ClauseFigure>(v2row.figures_json) : [],
      figureImages,
      matchedAs,
      requestedClauseId: matchedAs === "ancestor" ? id : undefined,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[corpus] lookupClause(${reference}) failed:`, err);
    return null;
  }
}

/** Cheap re-checkable column probe. PRAGMA table_info on a tiny table is
 *  ~microsecond cost so we do NOT cache across calls — a process-level
 *  cache would persist a v1 reading after an in-process upgrade to v2,
 *  which has caused silent wrong-path bugs. */
function corpusHasV2Columns(db: import("better-sqlite3").Database): boolean {
  try {
    const cols = db.prepare("PRAGMA table_info('clauses')").all() as Array<{ name: string }>;
    return cols.some(c => c.name === "tables_json");
  } catch {
    return false;
  }
}

/** True iff the corpus contains at least one leaf clause for the given
 *  spec (e.g. "38.211", "38.304"). Used by enrichExcerptsWithCorpus to
 *  distinguish "spec is curated but this clause / its descendants
 *  aren't leaves here" from "this spec was never curated" — two states
 *  the UI should explain differently. Not cached: an in-process corpus
 *  upgrade (v1→v2 or v2→v3) needs this to immediately reflect the new
 *  spec set, and a single PK index probe is microsecond-cheap. */
export function corpusHasSpec(spec: string): boolean {
  const db = getCorpusDb();
  if (!db) return false;
  try {
    // Match `<spec>#%` against the clauses PK — `<spec>` comes from the
    // 3GPP citation and `#` is our id separator (see 02-parse.ts of the
    // corpus pipeline).
    const row = db.prepare(
      "SELECT 1 FROM clauses WHERE id LIKE ? || '#%' LIMIT 1",
    ).get(spec) as { 1?: number } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

function safeJsonArray<T>(s: string): T[] {
  try {
    const parsed = JSON.parse(s) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
