import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch, bridgeTriage } from "@/lib/bridge";
import { buildMockDetail } from "@/lib/mock-data";

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
  const model = url.searchParams.get("model") || "haiku";

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

  // Step 2: invoke Claude Code via headless CLI
  try {
    const { triage } = await bridgeTriage(ticket, { model, timeoutMs: 270_000 });
    return NextResponse.json({ triage, source });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
