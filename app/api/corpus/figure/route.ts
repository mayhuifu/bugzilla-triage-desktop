// ─────────────────────────────────────────────────────────────────
// /api/corpus/figure — streams the raw bytes of a single
// figure_images blob from the v3 corpus.
//
// Usage:
//   GET /api/corpus/figure?clauseId=38.331%235.3.5.1&figureId=38.331%235.3.5.1/Figure-5.3.5-1
//
// We use query parameters instead of a deep path (`/figure/<clauseId>/<figureId>`)
// because clause ids contain `#` and figure ids contain `/`, both of
// which are awkward inside Next.js's dynamic-segment matcher even when
// percent-encoded by the client. Query-string carries them losslessly.
//
// Responses:
//   200 — bytes streamed with the right Content-Type and a 1-hour
//         private cache (the underlying SQLite never changes for a
//         given corpus version).
//   404 — corpus not installed, or the (clauseId, figureId) pair
//         doesn't exist (figure wasn't paired with media, or the corpus
//         is v1/v2 and the table is absent).
// ─────────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";
import { getFigureImageBlob } from "@/lib/corpus/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const clauseId = url.searchParams.get("clauseId");
  const figureId = url.searchParams.get("figureId");
  if (!clauseId || !figureId) {
    return NextResponse.json(
      { error: "both clauseId and figureId query parameters are required" },
      { status: 400 },
    );
  }
  const hit = getFigureImageBlob(clauseId, figureId);
  if (!hit) {
    return NextResponse.json(
      { error: `figure not found: ${clauseId} / ${figureId}` },
      { status: 404 },
    );
  }
  // Node's Buffer is a Uint8Array subclass and runtime-valid as a
  // BodyInit / BlobPart — but TypeScript's lib types since 5.7 narrow
  // `BlobPart` to `ArrayBufferView<ArrayBuffer>` rather than
  // `ArrayBufferView<ArrayBufferLike>`, and Node's Buffer is
  // `ArrayBufferLike` (might be backed by SharedArrayBuffer). The
  // copy-into-a-fresh-Uint8Array path forces a non-shared ArrayBuffer
  // so the type narrows correctly. Cost: one extra memcpy per image
  // (≤ 75 KB for a typical SVG; negligible).
  const fresh = new Uint8Array(hit.data.byteLength);
  fresh.set(hit.data);
  return new NextResponse(fresh, {
    status: 200,
    headers: {
      "Content-Type": hit.mimeType,
      "Content-Length": String(hit.data.byteLength),
      // The corpus SQLite is immutable for a given installed version.
      // Long private cache is safe because the bytes never change for
      // (clauseId, figureId); a new corpus version installs to a
      // fresh path and the desktop reopens the DB anyway.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
