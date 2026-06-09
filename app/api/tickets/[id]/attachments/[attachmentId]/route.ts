// ─────────────────────────────────────────────────────────────────
// Attachment proxy — streams a single Bugzilla attachment's bytes
// through the local Next.js server so the browser can render it
// inline (e.g. <img src="/api/tickets/123/attachments/456" />)
// without exposing the user's Bugzilla API key to client-side code.
//
// Bugzilla returns attachments as base64 inside a JSON envelope; we
// decode here and respond with the raw bytes + correct Content-Type.
//
// Caching: 5-minute private cache so flipping between tickets doesn't
// re-fetch the same image, but the data still expires fast enough that
// permission changes on the Bugzilla side don't get stale forever.
//
// Size limit: defers to lib/bugzilla.ts → attachments(), which already
// filters anything > 5 MB. Files above that cap return 404 — the
// component should render the standard file icon for those.
// ─────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { attachments } from "@/lib/bugzilla";
import { withUser } from "@/lib/users/with-user";

export const dynamic = "force-dynamic";

export const GET = withUser(async (
  _req: Request,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) => {
  const { id, attachmentId } = await params;
  const ticketId = parseInt(id, 10);
  const attId = parseInt(attachmentId, 10);
  if (!ticketId || !attId) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  try {
    const { attachments: all } = await attachments(ticketId);
    const hit = all.find(a => a.id === attId);
    if (!hit || !hit.base64) {
      // Either the attachment doesn't belong to this ticket, was
      // filtered out by the 5 MB cap in attachments(), or Bugzilla
      // returned an empty data field. Same response either way — the
      // UI degrades to a file icon.
      return NextResponse.json({ error: "attachment not found" }, { status: 404 });
    }
    const bytes = Buffer.from(hit.base64, "base64");
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": hit.contentType || "application/octet-stream",
        "Content-Length": String(bytes.byteLength),
        // Private cache — these bytes carry per-user permission semantics
        // on the Bugzilla side, so don't let a shared proxy cache them.
        "Cache-Control": "private, max-age=300",
        // `inline` lets the browser render images directly; for non-image
        // types it'll still trigger a download which is the right
        // fallback behaviour.
        "Content-Disposition": `inline; filename="${encodeURIComponent(hit.fileName || "attachment")}"`,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
});
