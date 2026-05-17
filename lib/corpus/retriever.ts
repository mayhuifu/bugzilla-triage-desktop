// ─────────────────────────────────────────────────────────────────
// lib/corpus/retriever.ts — pre-triage BM25 search + post-triage
// exact-clause lookup. Reads from the SQLite emitted by the corpus
// build pipeline (bugzilla-triage-corpus repo).
//
// Two entry points, called from app/api/tickets/[id]/triage/route.ts
// and lib/llm.ts respectively:
//
//   retrieveContext(ticket) → top-K=6 BM25 hits from `clauses_fts`.
//                             Result is injected into the model's user
//                             prompt as "## Reference spec excerpts".
//                             Reduces hallucinated citations because
//                             the model now sees real candidate clauses
//                             before deciding what to cite.
//
//   lookupClause(citation) → exact PK lookup. Used in
//                             enrichExcerptsWithCorpus() to fill the
//                             new SpecExcerpt.realText/title/parentTitle
//                             fields after the model has emitted its
//                             specReferences list.
//
// Both no-op-return when the corpus isn't installed (getCorpusDb() →
// null) so the triage path keeps working with the model's training-
// data paraphrase as the fallback.
// ─────────────────────────────────────────────────────────────────

import "server-only";
import type { TicketDetail } from "../types";
import { getCorpusDb } from "./store";

export interface RetrievedClause {
  clauseId: string;          // canonical id, e.g. "38.211#6.1.4"
  citation: string;          // human-readable, e.g. "3GPP TS 38.211 §6.1.4"
  title: string;
  parentTitle?: string;
  text: string;              // full clause text (capped for prompt injection)
  bm25Score?: number;        // negative number; lower (more negative) = better
}

// TOP_K tuned for precision-over-recall. Reduced from 6 in v0.1.7 after
// user feedback that some retrieved candidates were tangentially related
// — fewer hits reaching the model = fewer false-positive citations. If
// the model needs broader context for a hard ticket the user can toggle
// RAG off entirely and let the model reason from training data alone.
const TOP_K = 4;
const MAX_TEXT_CHARS = 1200; // per-clause cap when injecting into prompt

// Common English stopwords that confuse BM25 ranking when bag-of-words.
// FTS5 with the porter tokenizer handles morphology but doesn't have a
// stopword list out of the box, so we trim them client-side.
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

function buildFtsQuery(ticket: TicketDetail): string {
  const parts: string[] = [
    ticket.summary,
    ticket.description.slice(0, 2000),
    ticket.component,
    ...(ticket.keywords ?? []),
    // First couple of follow-up comments often hold concrete repro hints.
    ...ticket.comments.slice(1, 3).map(c => c.text.slice(0, 800)),
  ];
  const blob = parts.join(" ").toLowerCase();
  const tokens = blob
    // FTS5's MATCH parser treats `.`, `:`, `-`, `(`, `)`, `"`, etc. as
    // syntax characters. The simplest robust strategy is to strip
    // everything that isn't a letter/digit/space before tokenizing —
    // the unicode61 tokenizer used by clauses_fts splits on those
    // boundaries during indexing anyway, so we're not losing anything.
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(t => t.length >= 3 && t.length <= 32)
    .filter(t => !STOPWORDS.has(t));
  const uniq = Array.from(new Set(tokens)).slice(0, 40);
  // Add an NR/LTE bias term if the ticket clearly leans one way.
  // Duplicating the term in the query effectively weights it under BM25.
  const isNr = NR_HINTS.some(h => blob.includes(h));
  const isLte = LTE_HINTS.some(h => blob.includes(h));
  if (isNr && !isLte) uniq.push("nr", "nr");
  if (isLte && !isNr) uniq.push("lte", "lte");
  // FTS5 IMPORTANT: bare-token MATCH applies AND semantics by default,
  // which would require every doc to contain all 40 tokens — empirically
  // returns zero hits on real ticket text. Explicit OR gives the
  // recall-over-precision behavior we want; BM25 then ranks the hits
  // by which doc has the most matching terms.
  return uniq.join(" OR ");
}

export function retrieveContext(ticket: TicketDetail): RetrievedClause[] {
  const db = getCorpusDb();
  if (!db) return []; // corpus not installed → graceful no-op
  const query = buildFtsQuery(ticket);
  if (!query) return [];
  try {
    const rows = db.prepare(`
      SELECT c.id, c.spec, c.clause_no, c.citation, c.title, c.parent_title, c.text,
             bm25(clauses_fts) AS score
      FROM clauses_fts
      JOIN clauses c ON c.rowid = clauses_fts.rowid
      WHERE clauses_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(query, TOP_K) as Array<{
      id: string; spec: string; clause_no: string; citation: string;
      title: string; parent_title: string | null; text: string; score: number;
    }>;
    return rows.map(r => ({
      clauseId: r.id,
      citation: r.citation,
      title: r.title,
      parentTitle: r.parent_title ?? undefined,
      text: r.text.length > MAX_TEXT_CHARS
        ? r.text.slice(0, MAX_TEXT_CHARS) + "…"
        : r.text,
      bm25Score: r.score,
    }));
  } catch (err) {
    // BM25 query syntax error or DB problem — log and degrade to no-op.
    // eslint-disable-next-line no-console
    console.warn(`[corpus] retrieveContext failed:`, err);
    return [];
  }
}

/** Parse a model-emitted citation string into our canonical clause id.
 *  Tolerant of the various forms the model might produce:
 *    "3GPP TS 38.211 §6.1.4"
 *    "TS 38.211 section 6.1.4"
 *    "TS 38.211 clause 6.1.4"
 *    "TS 38.211, 6.1.4"
 *    "3GPP TS 38.211: 6.1.4"
 *  Returns null when the citation doesn't match any spec/clause shape. */
function parseCitation(reference: string): { spec: string; clauseNo: string } | null {
  const m = reference.match(/(?:TS|TR)\s+(\d+\.\d+(?:-\d+)?)\s*(?:§|sec(?:tion)?|cl(?:ause)?|:|,|\.|\s)+\s*([\d.]+)/i);
  if (!m) return null;
  // Strip trailing dot from clauseNo if the source had something like "6.1.4."
  return { spec: m[1], clauseNo: m[2].replace(/\.$/, "") };
}

export function lookupClause(reference: string): RetrievedClause | null {
  const db = getCorpusDb();
  if (!db) return null;
  const parsed = parseCitation(reference);
  if (!parsed) return null;
  const id = `${parsed.spec}#${parsed.clauseNo}`;
  try {
    const row = db.prepare(`
      SELECT id, citation, title, parent_title, text
      FROM clauses WHERE id = ?
    `).get(id) as { id: string; citation: string; title: string; parent_title: string | null; text: string } | undefined;
    if (!row) return null;
    return {
      clauseId: row.id,
      citation: row.citation,
      title: row.title,
      parentTitle: row.parent_title ?? undefined,
      text: row.text,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[corpus] lookupClause(${reference}) failed:`, err);
    return null;
  }
}
