import { NextRequest, NextResponse } from "next/server";
import { bridgeSubmit, bridgeFetch } from "@/lib/bridge";
import type { TriageSubmission, SubmissionReceipt, TicketStatus } from "@/lib/types";
import { TICKET_STATUSES } from "@/lib/types";
import { withUser } from "@/lib/users/with-user";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ALLOWED_TRANSITIONS = new Set<TicketStatus>(TICKET_STATUSES);

export const POST = withUser(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  const ticketId = parseInt(id);
  if (!ticketId) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const submission = (await req.json()) as TriageSubmission & { mock?: boolean };
  if (!submission?.comment?.trim()) {
    return NextResponse.json({ error: "comment is required" }, { status: 400 });
  }

  if (submission.transitionTo && !ALLOWED_TRANSITIONS.has(submission.transitionTo)) {
    return NextResponse.json(
      { error: `invalid transitionTo: ${submission.transitionTo}` },
      { status: 400 },
    );
  }

  if (submission.transitionTo === "RESOLVED" && !submission.resolution) {
    return NextResponse.json(
      { error: "resolution is required when transitionTo=RESOLVED" },
      { status: 400 },
    );
  }

  const explicitMock = submission.mock === true ||
                       new URL(req.url).searchParams.get("mock") === "1";

  if (explicitMock) {
    const receipt: SubmissionReceipt = {
      success: true,
      ticketId,
      commentId: Math.floor(70000 + Math.random() * 9999),
      newStatus: submission.transitionTo,
      postedAt: new Date().toISOString(),
      message: "Posted (mock — explicit ?mock=1)",
    };
    return NextResponse.json(receipt);
  }

  // Confirm the ticket is reachable on the real Bugzilla before mutating.
  // The triage step silently falls back to mock data when the bridge fails,
  // so a "live" UI banner does NOT guarantee the live path. Refuse to post
  // unless we can prove the ticket exists on the real instance right now.
  try {
    await bridgeFetch(ticketId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({
      success: false,
      ticketId,
      postedAt: new Date().toISOString(),
      message: `Refusing to submit: Bugzilla is unreachable (${msg}). The triage may have been generated against mock data.`,
    }, { status: 503 });
  }

  try {
    // For AI triage: the submit() helper auto-applies the
    // "Analyzed by AI Triage Bot:" prefix and the "Analyzed by AI Triage Bot"
    // cf_label per umsemi conventions. For manual triage
    // (submission.manual===true) both are skipped so we don't misattribute
    // human-authored comments to the bot.
    const receipt = await bridgeSubmit({
      id: ticketId,
      comment: submission.comment,
      transitionTo: submission.transitionTo,
      resolution: submission.resolution,
      manual: submission.manual === true,
    });
    return NextResponse.json(receipt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({
      success: false,
      ticketId,
      postedAt: new Date().toISOString(),
      message: `Failed to post via bridge: ${msg}`,
    }, { status: 502 });
  }
});
