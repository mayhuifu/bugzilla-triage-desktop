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
    // Reasonable cache size for ~40MB corpus (10MB) — read-only.
    _db.pragma("cache_size = -10000");
    _db.pragma("journal_mode = WAL");
    return _db;
  } catch (err) {
    // Corrupt file, locked, or wrong permissions — surface as no-corpus
    // rather than throwing. Operator can recover by re-downloading.
    // eslint-disable-next-line no-console
    console.warn(`[corpus] failed to open ${p}:`, err);
    _db = null;
    _path = null;
    return null;
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
