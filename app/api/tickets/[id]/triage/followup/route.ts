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

  const body = await req.json().catch(() => ({}));
  const instruction = (body.instruction as string) || "";

  const url = new URL(req.url);
  const explicitMock = url.searchParams.get("mock") === "1";
  const model = url.searchParams.get("model") || undefined;

  let ticket;
  try {
    ticket = explicitMock
      ? buildMockDetail(ticketId)
      : (await bridgeFetch(ticketId)).ticket;
  } catch {
    ticket = buildMockDetail(ticketId);
  }

  try {
    const { triage } = await bridgeTriage(ticket, {
      followup: instruction,
      model,
      timeoutMs: 270_000,
    });
    return NextResponse.json({ triage });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
