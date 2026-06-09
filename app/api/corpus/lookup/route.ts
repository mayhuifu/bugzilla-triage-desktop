import { NextResponse } from "next/server";
import { lookupClause } from "@/lib/corpus/retriever";
import { withUser } from "@/lib/users/with-user";

export const dynamic = "force-dynamic";

// GET /api/corpus/lookup?clause=<citation> — returns the full clause
// for a given citation, used by the SpecDrawer UI (M3). Returns 404
// when the citation doesn't parse, when the corpus is missing, or when
// the clause isn't in the corpus.
//
// Example:
//   GET /api/corpus/lookup?clause=3GPP%20TS%2038.211%20%C2%A76.3.1.1
//   → { clauseId: "38.211#6.3.1.1", citation: "...", title: "Scrambling",
//        parentTitle: "...", text: "<full clause text>" }
export const GET = withUser(async (req: Request) => {
  const url = new URL(req.url);
  const clause = url.searchParams.get("clause");
  if (!clause) {
    return NextResponse.json({ error: "missing ?clause= parameter" }, { status: 400 });
  }
  const result = lookupClause(clause);
  if (!result) {
    return NextResponse.json(
      { error: `clause not found in corpus: ${clause}` },
      { status: 404 },
    );
  }
  return NextResponse.json(result);
});
