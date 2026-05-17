import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch, bridgeTriage } from "@/lib/bridge";
import { buildMockDetail } from "@/lib/mock-data";
import { retrieveContext } from "@/lib/corpus/retriever";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ticketId = parseInt(id);
  if (!ticketId) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const url = new URL(req.url);
  const explicitMock = url.searchParams.get("mock") === "1";
  // No default: when omitted, triage_llm.py lets the claude CLI pick.
  const model = url.searchParams.get("model") || undefined;

  // Step 1: fetch ticket detail (live or mock)
  let ticket;
  let source = "bugzilla-mcp";
  try {
    if (explicitMock) {
      ticket = buildMockDetail(ticketId);
      source = "mock";
    } else {
      ticket = (await bridgeFetch(ticketId)).ticket;
    }
  } catch (err) {
    try {
      ticket = buildMockDetail(ticketId);
      source = "mock-fallback";
    } catch {
      return NextResponse.json({ error: (err as Error).message }, { status: 502 });
    }
  }

  // Step 2: retrieve candidate 3GPP clauses (v0.1.6 RAG). Wrapped in
  // try/catch and graceful no-op so a missing/broken corpus never
  // breaks triage — the model just falls back to its training-data
  // paraphrase like in v0.1.5.
  let retrievedClauses: ReturnType<typeof retrieveContext> = [];
  try {
    retrievedClauses = retrieveContext(ticket);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[triage] corpus retrieval failed (continuing without RAG):`, err);
  }

  // Step 3: invoke the LLM with retrieved-clause context. Post-triage
  // enrichment (looking up the model's specReferences against the corpus
  // to populate realText) is handled inside runTriage().
  try {
    const { triage } = await bridgeTriage(ticket, { model, timeoutMs: 270_000, retrievedClauses });
    return NextResponse.json({
      triage,
      source,
      retrievedClauseCount: retrievedClauses.length,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
