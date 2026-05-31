// ─────────────────────────────────────────────────────────────────
// lib/corpus/store.ts — lazy singleton handle to the local 3GPP
// corpus SQLite (better-sqlite3, FTS5 BM25).
//
// Lifecycle:
//   - getCorpusDb() returns the open Database when the corpus file
//     exists at `<userDataDir>/corpus/corpus.sqlite`, else null.
//   - closeCorpusDb() releases the handle. Called after a successful
//     download so the next getCorpusDb() picks up the new file.
//   - The handle is module-level — Next.js dev mode reuses one process,
//     so this is a per-process singleton, which is what we want.
//
// Why better-sqlite3 (and not node:sqlite or sql.js):
//   - synchronous API → no Promise jitter in the BM25 hot path
//   - per-platform prebuilds (darwin-arm64/x64, win32-x64, linux-x64)
//     load via require() without a system compiler
//   - FTS5 included in the prebuilt binary
//
// Why null vs throw on missing corpus:
//   - retriever.ts and the triage route both call this every triage
//   - a missing corpus is a normal "not opted in" state, not an error
//   - all callers graceful-no-op
// ─────────────────────────────────────────────────────────────────

import "server-only";
import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3";

import { appDataDir } from "../settings";

// better-sqlite3 is required lazily (see loadBetterSqlite3 below) rather
// than as a top-level import. The native .node binary can fail to load
// on a packaged Windows install — wrong arch prebuild, missing C runtime
// DLL, AV quarantine, etc. — and a top-level import would crash the
// module ENTIRE-WIDE, taking down every route handler that imports
// anything from this file, including /api/corpus/download which doesn't
// even need the database. Lazy require keeps the download path working
// even when retrieval is broken: the user can still install a fresh
// corpus and hopefully the new file loads.
//
// `type Database from "better-sqlite3"` is a TYPE-only import — TS
// strips it at compile time so no runtime require fires.
let _db: Database.Database | null = null;
let _path: string | null = null;
let _hasVec = false;     // true when sqlite-vec extension successfully loaded
                         // AND the corpus declares vector tables (schemaVersion>=2).
let _bs3LoadErr: string | null = null;  // last better-sqlite3 load error, if any
let _bs3: typeof Database | null = null;
let _openErr: string | null = null;     // last db.open() error (separate from
                                        // bs3 load errors so the diag endpoint
                                        // can distinguish "file missing /
                                        // corrupt / locked" from "native binary
                                        // failed to load").
let _lastTriedPath: string | null = null;
let _fileExistedOnTry: boolean | null = null;

/** Lazy-loader for better-sqlite3 so a missing/broken native binary
 *  doesn't crash module-load. First call resolves the constructor; on
 *  failure it records the error and every subsequent call returns null
 *  cheaply — getCorpusDb() then treats the corpus as "unopenable" and
 *  the rest of the app degrades gracefully. */
function loadBetterSqlite3(): typeof Database | null {
  if (_bs3) return _bs3;
  if (_bs3LoadErr) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _bs3 = require("better-sqlite3") as typeof Database;
    return _bs3;
  } catch (err) {
    _bs3LoadErr = (err as Error)?.message || String(err);
    // eslint-disable-next-line no-console
    console.error(`[corpus] better-sqlite3 require failed: ${_bs3LoadErr}`);
    return null;
  }
}

/** Diagnostic: tells callers whether the native sqlite binary is
 *  available at all. /api/corpus/status uses this to report
 *  "corpus engine unavailable" instead of a misleading "not installed". */
export function corpusEngineError(): string | null {
  if (_bs3) return null;
  loadBetterSqlite3();
  return _bs3LoadErr;
}

/** True when the open corpus carries dense vectors and sqlite-vec is loaded
 *  — i.e. when hybrid retrieval is available. False for v1 corpora and for
 *  v2-no-vec builds. Caller should treat this as a tri-state with getCorpusDb():
 *    db == null     → corpus not installed
 *    db != null + !hasVec → BM25-only path
 *    db != null +  hasVec → hybrid RRF available
 */
export function corpusHasVectors(): boolean {
  return _db !== null && _hasVec;
}

/** Where the corpus SQLite lives on disk. Stable across runs of the
 *  same user; never inside the installer bundle. */
export function corpusPath(): string {
  return path.join(appDataDir(), "corpus", "corpus.sqlite");
}

/** True when the open corpus has the v3 `figure_images` table
 *  populated (introduced in corpus rel17-v4 / schemaVersion=3). False
 *  for v1/v2 corpora (no table) and for v3 corpora where the table
 *  exists but is empty. Probed once per process. */
let _hasFigureImages: boolean | null = null;
export function corpusHasFigureImages(): boolean {
  if (_db === null) return false;
  if (_hasFigureImages !== null) return _hasFigureImages;
  try {
    // SQLite-typed query: master row presence + at least one image.
    const tablePresent = _db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='figure_images'",
    ).get();
    if (!tablePresent) { _hasFigureImages = false; return false; }
    const anyRow = _db.prepare("SELECT 1 FROM figure_images LIMIT 1").get();
    _hasFigureImages = !!anyRow;
  } catch {
    _hasFigureImages = false;
  }
  return _hasFigureImages;
}

/** Metadata about a single figure image stored alongside a clause.
 *  Carries everything the UI needs to render an `<img>` (mime + size)
 *  without forcing the caller to load the blob just to enumerate. */
export interface FigureImageMeta {
  clauseId: string;
  figureId: string;
  mimeType: string;
  bytes: number;
}

/** List the figure-image metadata rows for a clause id. Returns [] when
 *  the corpus is missing the table (v1/v2) or has no images for the
 *  clause. The blob itself is fetched separately via getFigureImageBlob
 *  so listing a clause's figures stays cheap and the API/JSON shape
 *  doesn't balloon with base64. */
export function getFigureImagesForClause(clauseId: string): FigureImageMeta[] {
  const db = getCorpusDb();
  if (!db || !corpusHasFigureImages()) return [];
  try {
    return db.prepare(`
      SELECT clause_id AS clauseId, figure_id AS figureId,
             mime_type AS mimeType, bytes
      FROM figure_images
      WHERE clause_id = ?
      ORDER BY figure_id
    `).all(clauseId) as FigureImageMeta[];
  } catch {
    return [];
  }
}

/** Load the raw bytes of a single figure image. Returns null when the
 *  (clauseId, figureId) pair doesn't exist OR the corpus is too old
 *  to have the table. The caller is responsible for setting the right
 *  Content-Type via the metadata row above. */
export function getFigureImageBlob(
  clauseId: string,
  figureId: string,
): { mimeType: string; data: Buffer } | null {
  const db = getCorpusDb();
  if (!db || !corpusHasFigureImages()) return null;
  try {
    const row = db.prepare(`
      SELECT mime_type AS mimeType, data
      FROM figure_images
      WHERE clause_id = ? AND figure_id = ?
    `).get(clauseId, figureId) as { mimeType: string; data: Buffer } | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/** Batch-probe which of the given clause ids have renderable figure
 *  images and/or structured tables. Used by /api/corpus/search to light
 *  the "figures"/"tables" chips on result cards WITHOUT loading any blobs
 *  — the ranking path (mapRows) doesn't carry this metadata, only a direct
 *  lookupClause does, so search cards would otherwise never show the hint.
 *
 *  Two set-membership queries for the whole result page (not per-row), so
 *  it's cheap. Every clause id is seeded false; a clause is `hasFigures`
 *  only when it has an actual image blob (a caption-only `figures_json`
 *  entry doesn't count — the chip promises a viewable diagram). Degrades
 *  to all-false on corpora missing the v3 `figure_images` table or the v2
 *  `tables_json` column. */
export function getClauseMediaFlags(
  clauseIds: string[],
): Map<string, { hasFigures: boolean; hasTables: boolean }> {
  const out = new Map<string, { hasFigures: boolean; hasTables: boolean }>();
  const db = getCorpusDb();
  if (!db || clauseIds.length === 0) return out;
  for (const id of clauseIds) out.set(id, { hasFigures: false, hasTables: false });
  const placeholders = clauseIds.map(() => "?").join(",");

  if (corpusHasFigureImages()) {
    try {
      const rows = db.prepare(
        `SELECT DISTINCT clause_id AS id FROM figure_images WHERE clause_id IN (${placeholders})`,
      ).all(...clauseIds) as Array<{ id: string }>;
      for (const r of rows) { const f = out.get(r.id); if (f) f.hasFigures = true; }
    } catch { /* table absent / query failed → leave flags false */ }
  }

  try {
    const rows = db.prepare(
      `SELECT id FROM clauses WHERE id IN (${placeholders})
         AND tables_json IS NOT NULL AND tables_json NOT IN ('', '[]')`,
    ).all(...clauseIds) as Array<{ id: string }>;
    for (const r of rows) { const f = out.get(r.id); if (f) f.hasTables = true; }
  } catch { /* tables_json column absent on v1 corpora → leave flags false */ }

  return out;
}

/** Lazily open the corpus DB. Returns null when the file is absent,
 *  so callers can decide whether to skip retrieval or surface the
 *  fact in the UI (e.g. a "download corpus" banner). */
export function getCorpusDb(): Database.Database | null {
  const p = corpusPath();
  _lastTriedPath = p;
  // Re-open if the path changes mid-process (download just finished and
  // renamed the file). We track _path to detect this case.
  if (_db && _path === p) return _db;
  const exists = fs.existsSync(p);
  _fileExistedOnTry = exists;
  if (!exists) {
    if (_db) closeCorpusDb();
    _openErr = `file does not exist at ${p}`;
    return null;
  }
  const Bs3 = loadBetterSqlite3();
  if (!Bs3) {
    // Native binary unavailable — the rest of the app continues without
    // corpus retrieval. Caller treats null exactly like "corpus not
    // installed" and falls back to the model's training-data paraphrase.
    _openErr = "better-sqlite3 native binary unavailable (see corpusEngineError)";
    return null;
  }
  try {
    _db = new Bs3(p, { readonly: true, fileMustExist: true });
    _path = p;
    _openErr = null;
    // Reasonable cache size for the ~40MB v1 corpus and the larger v2.
    _db.pragma("cache_size = -10000");
    _db.pragma("journal_mode = WAL");
    // Try to load sqlite-vec so vec0 MATCH on `clauses_vec` becomes available.
    // Missing on a host means hybrid retrieval is unavailable — the retriever
    // degrades to BM25-only, the rest of the app keeps working.
    _hasVec = tryLoadSqliteVec(_db) && detectVecTable(_db);
    return _db;
  } catch (err) {
    // Corrupt file, locked, or wrong permissions — surface as no-corpus
    // rather than throwing. Capture the error message so /api/corpus/diag
    // (and downstream UI hints) can show why the engine reported
    // engineLoaded=false even though the binary was available.
    const e = err as Error & { code?: string };
    _openErr = `${e?.name ?? "Error"}: ${e?.message ?? String(err)}${e?.code ? ` [${e.code}]` : ""}`;
    // eslint-disable-next-line no-console
    console.warn(`[corpus] failed to open ${p}:`, err);
    _db = null;
    _path = null;
    _hasVec = false;
    return null;
  }
}

/** Diagnostic: last db.open() failure (or "file does not exist…",
 *  or the native-binary load error message). Used by /api/corpus/diag
 *  so we can tell file-missing from corrupt-on-open vs engine-broken. */
export function corpusOpenError(): string | null {
  return _openErr;
}

/** Diagnostic: did the file exist on disk at the last getCorpusDb()
 *  attempt? null = not yet attempted. */
export function corpusFileExistedOnLastTry(): boolean | null {
  return _fileExistedOnTry;
}

/** Diagnostic: path used by the last getCorpusDb() attempt. */
export function corpusLastTriedPath(): string | null {
  return _lastTriedPath;
}

/** Best-effort load of the sqlite-vec extension. Returns false (and logs)
 *  when the package isn't installed or the native binary is missing for
 *  this platform — the retriever then falls back to BM25-only.
 *
 *  Loading strategy: sqlite-vec's official loader calls require.resolve()
 *  for the .dylib/.so/.dll subpath inside its per-platform sub-package.
 *  Next.js Webpack can't statically resolve those non-JS subpaths and
 *  errors out, so we keep that as the first attempt (works in pure-Node
 *  via tsx/electron) and fall back to a manual path lookup under
 *  process.cwd()/node_modules that Webpack leaves alone at build time. */
function tryLoadSqliteVec(db: Database.Database): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqliteVec = (() => {
    try {
      return require("sqlite-vec") as { load: (d: Database.Database) => void };
    } catch {
      return null;
    }
  })();
  if (sqliteVec) {
    try { sqliteVec.load(db); return true; } catch { /* fall through */ }
  }
  // Manual path resolution. Webpack can't statically analyse a path that
  // is built up at runtime from process.platform / process.arch, so this
  // survives bundling.
  try {
    const platDir =
      process.platform === "win32"
        ? `sqlite-vec-windows-${process.arch}`
        : `sqlite-vec-${process.platform}-${process.arch}`;
    const ext =
      process.platform === "win32" ? "dll" : process.platform === "darwin" ? "dylib" : "so";
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    const candidate = path.join(process.cwd(), "node_modules", platDir, `vec0.${ext}`);
    db.loadExtension(candidate);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.info(`[corpus] sqlite-vec not loaded (${(err as Error).message}); using BM25-only retrieval`);
    return false;
  }
}

/** Confirm the open corpus actually declares the vector virtual table. v1
 *  corpora and v2-no-vec corpora don't. */
function detectVecTable(db: Database.Database): boolean {
  try {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='clauses_vec'",
    ).get() as { name: string } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

/** Drop the handle so the next getCorpusDb() reopens. Called after the
 *  downloader atomically renames the new corpus into place. */
export function closeCorpusDb(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
  }
  _db = null;
  _path = null;
  _hasVec = false;
}

// ── Browse / TOC / acronym helpers (v0.5 spec workbench) ──────────
// All read-only, all degrade to [] when the corpus is absent or a table
// is missing (older corpora). The /spec page's sidebar + acronym pane
// call these via thin API routes.

export interface SpecSummary {
  spec: string;       // e.g. "TS 38.211"
  count: number;      // leaf clauses curated for this spec
}

/** Distinct curated specs with their leaf-clause counts, ordered by spec.
 *  Backs the /spec browse sidebar's spec list. */
export function listSpecs(): SpecSummary[] {
  const db = getCorpusDb();
  if (!db) return [];
  try {
    return db.prepare(
      "SELECT spec, COUNT(*) AS count FROM clauses GROUP BY spec ORDER BY spec",
    ).all() as SpecSummary[];
  } catch {
    return [];
  }
}

export interface TocClause {
  clauseId: string;
  clauseNo: string;
  citation: string;
  title: string;
  parentTitle: string | null;
}

/** All leaf clauses for one spec, ordered naturally by clause number
 *  (so 5.3.5.2 sorts before 5.3.5.10). Capped to keep the payload sane on
 *  the largest specs. Backs the sidebar's per-spec clause list. */
export function listSpecClauses(spec: string, limit = 4000): TocClause[] {
  const db = getCorpusDb();
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT id AS clauseId, clause_no AS clauseNo, citation, title, parent_title AS parentTitle
      FROM clauses WHERE spec = ? LIMIT ?
    `).all(spec, limit) as TocClause[];
    // Natural sort on the dotted clause number (lexical sort mis-orders
    // 5.3.5.10 before 5.3.5.2). Annex letters (A.7.5…) sort after digits.
    return rows.sort((a, b) => compareClauseNo(a.clauseNo, b.clauseNo));
  } catch {
    return [];
  }
}

function compareClauseNo(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const sa = pa[i] ?? "";
    const sb = pb[i] ?? "";
    const na = parseInt(sa, 10);
    const nb = parseInt(sb, 10);
    const aNum = !Number.isNaN(na);
    const bNum = !Number.isNaN(nb);
    if (aNum && bNum) {
      if (na !== nb) return na - nb;
    } else if (aNum !== bNum) {
      // Numeric segments (clauses) sort before alpha segments (annexes).
      return aNum ? -1 : 1;
    } else {
      const c = sa.localeCompare(sb);
      if (c !== 0) return c;
    }
  }
  return 0;
}

export interface AcronymRow {
  acronym: string;
  expansion: string;
  aliases: string[];
}

/** Look up acronyms by prefix/substring across acronym, expansion, and
 *  aliases. Empty query returns the full glossary (capped). Original case
 *  is preserved (the in-memory expansion cache lowercases, so we read the
 *  table directly for display). Returns [] on corpora without the table. */
export function searchAcronyms(query: string, limit = 50): AcronymRow[] {
  const db = getCorpusDb();
  if (!db) return [];
  try {
    const q = query.trim();
    let rows: Array<{ acronym: string; expansion: string; aliases: string }>;
    if (!q) {
      rows = db.prepare(
        "SELECT acronym, expansion, aliases FROM acronyms ORDER BY acronym LIMIT ?",
      ).all(limit) as typeof rows;
    } else {
      const like = `%${q.replace(/[%_]/g, m => "\\" + m)}%`;
      const prefix = `${q.replace(/[%_]/g, m => "\\" + m)}%`;
      rows = db.prepare(`
        SELECT acronym, expansion, aliases FROM acronyms
        WHERE acronym LIKE ? ESCAPE '\\' OR expansion LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\'
        ORDER BY (acronym LIKE ? ESCAPE '\\') DESC, LENGTH(acronym), acronym
        LIMIT ?
      `).all(like, like, like, prefix, limit) as typeof rows;
    }
    return rows.map(r => {
      let aliases: string[] = [];
      try {
        const p = JSON.parse(r.aliases) as unknown;
        if (Array.isArray(p)) aliases = p.filter((x): x is string => typeof x === "string");
      } catch { /* keep empty */ }
      return { acronym: r.acronym, expansion: r.expansion, aliases };
    });
  } catch {
    return [];
  }
}

/** Read corpus metadata (version, build date, schema version). Used by
 *  /api/corpus/status. Returns null when corpus is absent. */
export function getCorpusMeta(): Record<string, string> | null {
  const db = getCorpusDb();
  if (!db) return null;
  try {
    const rows = db.prepare("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  } catch {
    return null;
  }
}
