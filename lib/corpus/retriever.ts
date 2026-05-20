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
import { corpusHasVectors, getCorpusDb } from "./store";
import { expandAcronyms } from "./acronyms";
import { getCorpusEmbedder } from "./embedder";

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
}

export interface RetrievedClause {
  clauseId: string;          // canonical id, e.g. "38.211#6.1.4"
  citation: string;          // human-readable, e.g. "3GPP TS 38.211 §6.1.4"
  title: string;
  parentTitle?: string;
  text: string;              // full clause text (capped for prompt injection)
  bm25Score?: number;        // negative number; lower (more negative) = better
  /** Retrieval source label for the SpecDrawer / debug surface. */
  retrieverPath?: "bm25-v1" | "bm25-v2" | "hybrid-rrf";
  /** Structured tables (v2 only). Empty array on v1 corpora. */
  tables?: ClauseTable[];
  /** Figure references (v2 only). */
  figures?: ClauseFigure[];
}

const TOP_K = 4;
const MAX_TEXT_CHARS = 1200; // per-clause cap when injecting into prompt

// Hybrid retrieval constants — mirrored from the corpus pipeline so the
// runtime behaviour matches what 05-eval.ts measures at build time.
const RRF_K = 60;
const CANDIDATES_PER_SOURCE = 50;

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

function tokenizeTicket(ticket: TicketDetail): string[] {
  const parts: string[] = [
    ticket.summary,
    ticket.description.slice(0, 2000),
    ticket.component,
    ...(ticket.keywords ?? []),
    ...ticket.comments.slice(1, 3).map(c => c.text.slice(0, 800)),
  ];
  const blob = parts.join(" ").toLowerCase();
  const tokens = blob
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(t => t.length >= 3 && t.length <= 32)
    .filter(t => !STOPWORDS.has(t));
  return Array.from(new Set(tokens));
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
function bm25Retrieve(matchExpr: string, label: "bm25-v1" | "bm25-v2"): RetrievedClause[] {
  const db = getCorpusDb();
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT c.id, c.spec, c.clause_no, c.citation, c.title, c.parent_title, c.text,
             bm25(clauses_fts) AS score
      FROM clauses_fts
      JOIN clauses c ON c.rowid = clauses_fts.rowid
      WHERE clauses_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(matchExpr, TOP_K) as CandidateRow[];
    return mapRows(rows, label);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[corpus] ${label} retrieval failed:`, err);
    return [];
  }
}

/** Hybrid RRF path. Returns empty array on any failure so caller can
 *  fall through to BM25 — never throws. */
async function hybridRetrieve(matchExpr: string, queryText: string): Promise<RetrievedClause[]> {
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
      matchExpr, CANDIDATES_PER_SOURCE,
      vecToBlob(vec), CANDIDATES_PER_SOURCE,
      RRF_K, TOP_K,
    ) as CandidateRow[];
    return mapRows(rows, "hybrid-rrf");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[corpus] hybrid retrieval failed:`, err);
    return [];
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
    const hits = await hybridRetrieve(q.match, queryText);
    if (hits.length > 0) return hits;
    // Fall through on empty / error.
    return bm25Retrieve(q.match, "bm25-v2");
  }
  return retrieveContext(ticket);
}

/** Parse a model-emitted citation string into our canonical clause id.
 *  Tolerant of the various forms the model might produce. */
function parseCitation(reference: string): { spec: string; clauseNo: string } | null {
  const m = reference.match(/(?:TS|TR)\s+(\d+\.\d+(?:-\d+)?)\s*(?:§|sec(?:tion)?|cl(?:ause)?|:|,|\.|\s)+\s*([\d.]+)/i);
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
    const row = hasV2Cols
      ? (db.prepare(`
          SELECT id, citation, title, parent_title, text,
                 COALESCE(tables_json, '[]')  AS tables_json,
                 COALESCE(figures_json, '[]') AS figures_json
          FROM clauses WHERE id = ?
        `).get(id) as V2Row | undefined)
      : (db.prepare(`
          SELECT id, citation, title, parent_title, text
          FROM clauses WHERE id = ?
        `).get(id) as V1Row | undefined);
    if (!row) return null;
    const v2row = hasV2Cols ? (row as V2Row) : null;
    return {
      clauseId: row.id,
      citation: row.citation,
      title: row.title,
      parentTitle: row.parent_title ?? undefined,
      text: row.text,
      tables: v2row ? safeJsonArray<ClauseTable>(v2row.tables_json) : [],
      figures: v2row ? safeJsonArray<ClauseFigure>(v2row.figures_json) : [],
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[corpus] lookupClause(${reference}) failed:`, err);
    return null;
  }
}

let _v2ColsChecked = false;
let _v2ColsPresent = false;
function corpusHasV2Columns(db: import("better-sqlite3").Database): boolean {
  if (_v2ColsChecked) return _v2ColsPresent;
  _v2ColsChecked = true;
  try {
    const cols = db.prepare("PRAGMA table_info('clauses')").all() as Array<{ name: string }>;
    _v2ColsPresent = cols.some(c => c.name === "tables_json");
  } catch {
    _v2ColsPresent = false;
  }
  return _v2ColsPresent;
}

function safeJsonArray<T>(s: string): T[] {
  try {
    const parsed = JSON.parse(s) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
