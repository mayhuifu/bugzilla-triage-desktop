import { NextResponse } from "next/server";
import { listSpecs, listSpecClauses } from "@/lib/corpus/store";

export const dynamic = "force-dynamic";

// GET /api/corpus/toc            → { specs: [{spec, count}] }
// GET /api/corpus/toc?spec=TS 38.211 → { spec, clauses: [{clauseId, clauseNo, citation, title, parentTitle}] }
//
// Backs the /spec browse sidebar. No LLM, no network — pure local SQLite
// reads. Returns empty lists (200) when no corpus is installed so the
// sidebar renders a calm "install the corpus" hint rather than erroring.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const spec = url.searchParams.get("spec");
  if (spec) {
    return NextResponse.json({ spec, clauses: listSpecClauses(spec) });
  }
  return NextResponse.json({ specs: listSpecs() });
}
