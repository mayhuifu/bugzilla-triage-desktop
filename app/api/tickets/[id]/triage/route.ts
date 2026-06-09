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

  const url = new URL(req.url);
  const explicitMock = url.searchParams.get("mock") === "1";
  // No default: when omitted, triage_llm.py lets the claude CLI pick.
  const model = url.searchParams.get("model") || undefined;
  // ?rag=1|0|<absent> — per-triage opt-in for the 3GPP corpus.
  // Absent → defaults to true (preserves v0.1.6/v0.1.7 behavior).
  // 0 / false → disables both pre-triage retrieval and post-triage
  // enrichment. The TriageChatPanel sets this from a localStorage-
  // backed user preference so non-cellular tickets don't get clobbered
  // by tangential corpus matches.
  const ragParam = url.searchParams.get("rag");
  const useRag = ragParam == null ? true : ragParam !== "0" && ragParam !== "false";

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

  // Step 2: retrieve candidate 3GPP clauses (v0.1.6 RAG, opt-in v0.1.7).
  // Skipped entirely when the user disabled RAG for this triage —
  // non-cellular tickets benefit from a clean prompt rather than
  // tangentially-related corpus matches.
  let retrievedClauses: ReturnType<typeof retrieveContext> = [];
  if (useRag) {
    try {
      // Async path activates hybrid RRF when a query embedder is registered
      // AND its modelId matches the corpus's meta.embeddingModel. Otherwise
      // it falls back to the same BM25 path as before — no behaviour change.
      retrievedClauses = await retrieveContextAsync(ticket);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[triage] corpus retrieval failed (continuing without RAG):`, err);
    }
  }

  // Step 3: invoke the LLM. Both prompt injection and post-triage
  // enrichment are gated on `useRag`.
  try {
    const { triage } = await bridgeTriage(ticket, {
      model,
      timeoutMs: 270_000,
      retrievedClauses,
      enrichWithCorpus: useRag,
    });
    return NextResponse.json({
      triage,
      source,
      retrievedClauseCount: retrievedClauses.length,
      ragEnabled: useRag,
      // Compact summary of what BM25 surfaced — citation + title only,
      // no full text. The UI renders this in a retrieval-info chat turn
      // so the user can see what the model considered before citing
      // (or NOT citing). Empty array when RAG was disabled or the
      // corpus turned up nothing.
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
