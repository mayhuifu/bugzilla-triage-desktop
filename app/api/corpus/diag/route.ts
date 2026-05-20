// ──────────────────────────────────────────────────────────────────
// /api/corpus/diag — diagnostic endpoint for debugging "RAG enabled
// but every citation comes back [ai paraphrase]" on user installs.
//
// Returns a JSON dump of:
//   - engine load state (engineError or null)
//   - resolved corpus file path (relative to appDataDir())
//   - meta table: schemaVersion, embeddingModel, totalClauses, etc.
//   - whether the v2 columns (tables_json) are present
//   - a live test of lookupClause() on three reference citations:
//       1. "3GPP TS 38.211 §7.4.2.2" (known v2 non-leaf with descendants)
//       2. "3GPP TS 38.331 §5.3.5"   (known v2 non-leaf with descendants)
//       3. "3GPP TS 38.211 §6.3.2.1" (known v2 leaf — exact match)
//   - the raw clauses LIKE 38.211#7.4.2.2.% (top 5) — so we can see
//     whether the descendants exist on disk regardless of lookupClause
//
// Users hit this once and paste the JSON back. From the response shape
// we can immediately diagnose whether the issue is in the engine, the
// SQL, the citation parser, or the corpus content itself.
// ──────────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  getCorpusDb,
  getCorpusMeta,
  corpusEngineError,
  corpusOpenError,
  corpusFileExistedOnLastTry,
  corpusPath,
} from "@/lib/corpus/store";
import { lookupClause } from "@/lib/corpus/retriever";

export const dynamic = "force-dynamic";

interface LookupTrace {
  reference: string;
  hit: boolean;
  clauseId?: string;
  matchedAs?: string;
  requestedClauseId?: string;
  title?: string;
  textLen?: number;
}

function traceLookup(reference: string): LookupTrace {
  const r = lookupClause(reference);
  if (!r) return { reference, hit: false };
  return {
    reference,
    hit: true,
    clauseId: r.clauseId,
    matchedAs: r.matchedAs,
    requestedClauseId: r.requestedClauseId,
    title: r.title,
    textLen: r.text?.length ?? 0,
  };
}

export async function GET() {
  try {
    const engineError = corpusEngineError();
    const meta = getCorpusMeta();
    const db = getCorpusDb();  // populates corpusOpenError / corpusFileExistedOnLastTry
    const p = corpusPath();

    // Independent filesystem check — don't rely on the store's cached
    // existence reading. Walks the path's parent too so we can see
    // whether the directory itself exists (the download may have
    // partially failed before creating corpus.sqlite).
    let fileExists = false;
    let fileSizeBytes: number | null = null;
    let fileMtime: string | null = null;
    let dirExists = false;
    let dirContents: string[] = [];
    try {
      const stat = fs.statSync(p);
      fileExists = stat.isFile();
      fileSizeBytes = stat.size;
      fileMtime = stat.mtime.toISOString();
    } catch { /* ENOENT etc. — fileExists stays false */ }
    try {
      const parent = path.dirname(p);
      const dstat = fs.statSync(parent);
      dirExists = dstat.isDirectory();
      if (dirExists) {
        dirContents = fs.readdirSync(parent).slice(0, 20);
      }
    } catch { /* parent missing too */ }

    // Probe the schema directly. Don't trust cached state — we want the
    // ground truth as the user's process would see it RIGHT NOW.
    let hasV2Cols = false;
    let v2ColsList: string[] = [];
    let totalRows: number | null = null;
    let sample38211_7422: string[] = [];
    let sample38211_7422_dot: string[] = [];
    let leaf38211_6321Exists = false;
    if (db) {
      try {
        const cols = db.prepare("PRAGMA table_info('clauses')").all() as Array<{ name: string }>;
        v2ColsList = cols.map(c => c.name);
        hasV2Cols = v2ColsList.includes("tables_json");
      } catch (e) {
        v2ColsList = [`PRAGMA failed: ${(e as Error).message}`];
      }
      try {
        totalRows = (db.prepare("SELECT COUNT(*) AS n FROM clauses").get() as { n: number }).n;
      } catch (e) {
        totalRows = -1;
      }
      try {
        // Exact id we expect from parseCitation:
        sample38211_7422 = (db.prepare(
          "SELECT id FROM clauses WHERE id = ?"
        ).all("38.211#7.4.2.2") as Array<{ id: string }>).map(r => r.id);
        // Descendants — ancestor pattern:
        sample38211_7422_dot = (db.prepare(
          "SELECT id FROM clauses WHERE id LIKE '38.211#7.4.2.2.%' ORDER BY id LIMIT 5"
        ).all() as Array<{ id: string }>).map(r => r.id);
        leaf38211_6321Exists = !!db.prepare(
          "SELECT 1 FROM clauses WHERE id = '38.211#6.3.2.1' LIMIT 1"
        ).get();
      } catch (e) {
        sample38211_7422 = [`SQL probe failed: ${(e as Error).message}`];
      }
    }

    const out = {
      app: "bugzilla-triage-desktop",
      corpusFilePath: p,
      corpusFileSuffix: path.basename(path.dirname(p)) + "/" + path.basename(p),
      fileExists,
      fileSizeBytes,
      fileMtime,
      dirExists,
      dirContents,
      engineLoaded: !!db,
      engineError,
      openError: corpusOpenError(),                    // why the engine returned null even when bs3 loaded
      fileExistedOnLastOpen: corpusFileExistedOnLastTry(),
      meta: meta ?? null,
      schema: {
        hasV2Cols,
        columns: v2ColsList,
        totalRows,
      },
      probes: {
        "exact: 38.211#7.4.2.2": sample38211_7422,
        "LIKE 38.211#7.4.2.2.%": sample38211_7422_dot,
        "leaf 38.211#6.3.2.1 exists": leaf38211_6321Exists,
      },
      lookups: [
        traceLookup("3GPP TS 38.211 §7.4.2.2"),    // non-leaf, expect ancestor → 7.4.2.2.1
        traceLookup("3GPP TS 38.331 §5.3.5"),       // non-leaf, expect ancestor → 5.3.5.1
        traceLookup("3GPP TS 38.211 §6.3.2.1"),     // leaf, expect exact
        traceLookup("3GPP TS 38.304 §5.2.4.5"),     // not curated in v2, expect hit=false
      ],
    };
    return NextResponse.json(out, { status: 200 });
  } catch (err) {
    const e = err as Error;
    return NextResponse.json(
      { error: `diag failed: ${e?.name ?? "Error"}: ${e?.message ?? String(err)}` },
      { status: 500 },
    );
  }
}
