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
import Database from "better-sqlite3";

import { appDataDir } from "../settings";

let _db: Database.Database | null = null;
let _path: string | null = null;
let _hasVec = false;     // true when sqlite-vec extension successfully loaded
                         // AND the corpus declares vector tables (schemaVersion>=2).

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

/** Lazily open the corpus DB. Returns null when the file is absent,
 *  so callers can decide whether to skip retrieval or surface the
 *  fact in the UI (e.g. a "download corpus" banner). */
export function getCorpusDb(): Database.Database | null {
  const p = corpusPath();
  // Re-open if the path changes mid-process (download just finished and
  // renamed the file). We track _path to detect this case.
  if (_db && _path === p) return _db;
  if (!fs.existsSync(p)) {
    if (_db) closeCorpusDb();
    return null;
  }
  try {
    _db = new Database(p, { readonly: true, fileMustExist: true });
    _path = p;
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
    // rather than throwing. Operator can recover by re-downloading.
    // eslint-disable-next-line no-console
    console.warn(`[corpus] failed to open ${p}:`, err);
    _db = null;
    _path = null;
    _hasVec = false;
    return null;
  }
}

/** Best-effort load of the sqlite-vec extension. Returns false (and logs)
 *  when the package isn't installed or the native binary is missing for
 *  this platform — the retriever then falls back to BM25-only. */
function tryLoadSqliteVec(db: Database.Database): boolean {
  try {
    // Dynamically required so the dependency stays optional at runtime —
    // tests / minimal builds without sqlite-vec installed still work.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require("sqlite-vec") as { load: (d: Database.Database) => void };
    sqliteVec.load(db);
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
