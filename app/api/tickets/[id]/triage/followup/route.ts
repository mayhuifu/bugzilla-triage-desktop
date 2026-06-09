import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch, bridgeTriage } from "@/lib/bridge";
import { buildMockDetail } from "@/lib/mock-data";
import { retrieveContext, retrieveContextAsync } from "@/lib/corpus/retriever";
import { withUser } from "@/lib/users/with-user";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = withUser(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  const ticketId = parseInt(id);
  if (!ticketId) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const instruction = (body.instruction as string) || "";

  const url = new URL(req.url);
  const explicitMock = url.searchParams.get("mock") === "1";
  const model = url.searchParams.get("model") || undefined;
  // ?rag=0 disables corpus retrieval for this refinement — same flag
  // shape as the initial /triage route. Default is true.
  const ragParam = url.searchParams.get("rag");
  const useRag = ragParam == null ? true : ragParam !== "0" && ragParam !== "false";

  let ticket;
  try {
    ticket = explicitMock
      ? buildMockDetail(ticketId)
      : (await bridgeFetch(ticketId)).ticket;
  } catch {
    ticket = buildMockDetail(ticketId);
  }

  // Re-run retrieval on the (unchanged) ticket text so the refined
  // triage gets the same candidate clauses. The followup instruction
  // alone isn't a strong enough signal to re-rank. Skipped when the
  // per-triage RAG toggle is off.
  let retrievedClauses: ReturnType<typeof retrieveContext> = [];
  if (useRag) {
    try {
      retrievedClauses = await retrieveContextAsync(ticket);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[triage/followup] corpus retrieval failed (continuing without RAG):`, err);
    }
  }

  try {
    const { triage } = await bridgeTriage(ticket, {
      followup: instruction,
      model,
      timeoutMs: 270_000,
      retrievedClauses,
      enrichWithCorpus: useRag,
    });
    return NextResponse.json({
      triage,
      ragEnabled: useRag,
      retrievedClauseCount: retrievedClauses.length,
      retrievedClauses: retrievedClauses.map(c => ({
        citation: c.citation,
        title: c.title,
        parentTitle: c.parentTitle ?? null,
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
});
