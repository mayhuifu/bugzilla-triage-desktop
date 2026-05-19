// ─────────────────────────────────────────────────────────────────
// lib/corpus/acronyms.ts — query-time acronym expansion.
//
// Corpus v2 ships an `acronyms` table populated from the build-pipeline's
// curated glossary (~150 entries: PUSCH, BWP, SRB, etc. + aliases). At
// query time we look at each token in the bug text; if it matches an
// acronym we additionally OR-in the expansion's content tokens. This
// helps the v1-style BM25 path catch clauses that spell things out
// instead of using acronyms (e.g. a clause that says "Physical Uplink
// Control Channel" without using "PUCCH").
//
// No-op on v1 corpora (no `acronyms` table → cache is empty).
//
// The cache is loaded lazily on first use and invalidated by
// closeCorpusDb() — store.ts calls clearAcronymCache() in that path.
// ─────────────────────────────────────────────────────────────────

import "server-only";
import { getCorpusDb } from "./store";

interface AcronymEntry {
  acronym: string;     // normalised lowercase
  expansion: string;   // raw expansion text
  aliases: string[];   // normalised lowercase alternative forms
}

let _cache: Map<string, AcronymEntry> | null = null;

function loadCache(): Map<string, AcronymEntry> {
  if (_cache) return _cache;
  const db = getCorpusDb();
  const c = new Map<string, AcronymEntry>();
  if (!db) { _cache = c; return c; }
  try {
    const rows = db.prepare(
      "SELECT acronym, expansion, aliases FROM acronyms",
    ).all() as Array<{ acronym: string; expansion: string; aliases: string }>;
    for (const r of rows) {
      let aliases: string[] = [];
      try {
        const parsed = JSON.parse(r.aliases) as unknown;
        if (Array.isArray(parsed)) aliases = parsed.filter((x): x is string => typeof x === "string");
      } catch { /* keep aliases empty */ }
      const entry: AcronymEntry = {
        acronym: r.acronym.toLowerCase(),
        expansion: r.expansion,
        aliases: aliases.map(a => a.toLowerCase()),
      };
      c.set(entry.acronym, entry);
      // Aliases ALSO trigger expansion → catch "ENodeB" hitting eNB row, etc.
      for (const a of entry.aliases) {
        if (!c.has(a)) c.set(a, entry);
      }
    }
  } catch {
    // No acronyms table (v1 corpus) — leave the cache empty.
  }
  _cache = c;
  return c;
}

export function clearAcronymCache(): void {
  _cache = null;
}

/** Extract content-bearing tokens from an expansion. Drops short fillers
 *  ("of", "for") and parenthetical hints so what we OR into the FTS query
 *  is the actually-distinctive vocabulary. */
function expansionTokens(expansion: string): string[] {
  return expansion
    .toLowerCase()
    // Strip parenthetical hints like "(MR-DC)" or "(NR for RedCap UEs)".
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter(t => t.length >= 3);
}

/** Augment a tokenised bug-text query with acronym expansion content.
 *  Input is already-tokenised (the caller has done stopword+casing work);
 *  output is the same shape with extra tokens appended. Duplicates are
 *  removed by the caller via Set() before MATCHing. */
export function expandAcronyms(tokens: string[]): string[] {
  const cache = loadCache();
  if (cache.size === 0) return tokens;
  const seen = new Set(tokens.map(t => t.toLowerCase()));
  const extras: string[] = [];
  for (const t of tokens) {
    const lc = t.toLowerCase();
    const hit = cache.get(lc);
    if (!hit) continue;
    for (const w of expansionTokens(hit.expansion)) {
      if (!seen.has(w)) {
        seen.add(w);
        extras.push(w);
      }
    }
  }
  return [...tokens, ...extras];
}
