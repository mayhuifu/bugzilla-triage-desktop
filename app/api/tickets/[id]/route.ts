import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";
import { buildMockDetail } from "@/lib/mock-data";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ticketId = parseInt(id);
  if (!ticketId) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const explicitMock = new URL(req.url).searchParams.get("mock") === "1";
  if (explicitMock) {
    try {
      return NextResponse.json({ ticket: buildMockDetail(ticketId), source: "mock" });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 404 });
    }
  }

  try {
    const { ticket } = await bridgeFetch(ticketId);
    return NextResponse.json({ ticket, source: "bugzilla-mcp" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    try {
      return NextResponse.json({
        ticket: buildMockDetail(ticketId),
        source: "mock-fallback",
        error: msg,
      });
    } catch {
      return NextResponse.json({ error: msg }, { status: 502 });
    }
  }
}
