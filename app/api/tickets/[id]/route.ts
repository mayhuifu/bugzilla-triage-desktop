import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch, bridgeUpdateBug } from "@/lib/bridge";
import { buildMockDetail } from "@/lib/mock-data";
import { withUser } from "@/lib/users/with-user";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // a slow Bugzilla PUT

export const GET = withUser(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
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
});

// ── PATCH: direct field edits (component / priority / assignee / CC) + comment ──
// Stage-and-save from the ticket view: the client sends only the fields that
// changed; this commits them as ONE atomic Bugzilla PUT. Mirrors the submit
// route's safety: refuse to write unless the ticket is reachable live right
// now (the GET above silently mock-falls-back, so a "live" UI is not proof).
export const PATCH = withUser(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  const ticketId = parseInt(id);
  if (!ticketId) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  let body: {
    component?: string; priority?: string; assignedTo?: string;
    ccAdd?: string[]; ccRemove?: string[]; comment?: string; mock?: boolean;
  };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 400 }); }

  const hasChange =
    !!body.component?.trim() || !!body.priority?.trim() || !!body.assignedTo?.trim() ||
    (Array.isArray(body.ccAdd) && body.ccAdd.length > 0) ||
    (Array.isArray(body.ccRemove) && body.ccRemove.length > 0) ||
    (typeof body.comment === "string" && body.comment.trim().length > 0);
  if (!hasChange) return NextResponse.json({ error: "no changes provided" }, { status: 400 });

  const explicitMock = body.mock === true || new URL(req.url).searchParams.get("mock") === "1";
  if (explicitMock) {
    const changed = [
      body.component?.trim() && "component",
      body.priority?.trim() && "priority",
      body.assignedTo?.trim() && "assignee",
      ((body.ccAdd?.length || body.ccRemove?.length) ? "cc" : ""),
      (body.comment?.trim() ? "comment" : ""),
    ].filter(Boolean);
    return NextResponse.json({
      success: true, ticketId, changed,
      postedAt: new Date().toISOString(),
      message: "Updated (mock — explicit ?mock=1)",
    });
  }

  try { await bridgeFetch(ticketId); }
  catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({
      success: false, ticketId,
      message: `Refusing to update: Bugzilla is unreachable (${msg}).`,
    }, { status: 503 });
  }

  try {
    const receipt = await bridgeUpdateBug({
      id: ticketId,
      component: body.component,
      priority: body.priority,
      assignedTo: body.assignedTo,
      ccAdd: body.ccAdd,
      ccRemove: body.ccRemove,
      comment: body.comment,
    });
    return NextResponse.json(receipt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({
      success: false, ticketId,
      message: `Failed to update: ${msg}`,
    }, { status: 502 });
  }
});
