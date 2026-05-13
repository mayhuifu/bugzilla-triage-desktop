import { NextRequest, NextResponse } from "next/server";
import { bridgeSubmit } from "@/lib/bridge";
import type { TriageSubmission, SubmissionReceipt } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ticketId = parseInt(id);
  if (!ticketId) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const submission = (await req.json()) as TriageSubmission & { mock?: boolean };
  if (!submission?.comment?.trim()) {
    return NextResponse.json({ error: "comment is required" }, { status: 400 });
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

  try {
    // The Python skill auto-applies the "Analyzed by Claude:" prefix and
    // the "Analyzed by Claude" cf_label per umsemi conventions.
    const receipt = await bridgeSubmit({
      id: ticketId,
      comment: submission.comment,
      transitionTo: submission.transitionTo,
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
}
