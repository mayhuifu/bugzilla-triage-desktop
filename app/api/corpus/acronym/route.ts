import { NextResponse } from "next/server";
import { searchAcronyms } from "@/lib/corpus/store";

export const dynamic = "force-dynamic";

// GET /api/corpus/acronym?q=HARQ&limit=20 — 3GPP acronym lookup over the
// corpus's curated glossary (152 entries). Empty q returns the full
// glossary (capped). Backs the /spec acronym pane. No LLM, no network.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") || "";
  const limitParam = parseInt(url.searchParams.get("limit") || "", 10);
  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(limitParam, 200)) : 50;
  return NextResponse.json({ query: q, results: searchAcronyms(q, limit) });
}
