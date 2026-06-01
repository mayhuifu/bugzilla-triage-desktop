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

/** Crop a LibreOffice page-export SVG to its drawn content.
 *
 *  The WMF/EMF → SVG conversion (soffice, in the corpus build) emits the
 *  figure on a full US-Letter canvas: `width="215.9mm" height="279.4mm"`,
 *  `viewBox="0 0 21590 27940"`, with the actual diagram a small band in the
 *  vertical middle. Rendered as-is, the diagram looks tiny and off-centre
 *  while the sibling PNGs (tight crops) fill the width — the scale mismatch
 *  the user reported.
 *
 *  LibreOffice helpfully tags the drawn extents with `class="BoundingBox"`
 *  rects. We union them to get the content box, rewrite the root viewBox to
 *  it (+ small padding), and drop the page-sized width/height so the <img>
 *  adopts the cropped (landscape) aspect ratio and scales to fill. Pure
 *  string rewrite — no SVG renderer needed. Returns null (serve original)
 *  when there are no BoundingBox markers or the content already fills the
 *  page. */
function cropPageSvg(buf: Uint8Array): string | null {
  try {
    const svg = Buffer.from(buf).toString("utf8");
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
    for (const m of svg.matchAll(/<rect\b[^>]*class="BoundingBox"[^>]*>/g)) {
      const tag = m[0];
      const num = (re: RegExp): number => {
        const hit = re.exec(tag);
        return hit ? parseFloat(hit[1]) : NaN;
      };
      const x = num(/\bx="([\d.-]+)"/), y = num(/\by="([\d.-]+)"/);
      const w = num(/\bwidth="([\d.-]+)"/), h = num(/\bheight="([\d.-]+)"/);
      if ([x, y, w, h].some(Number.isNaN) || w <= 0 || h <= 0) continue;
      n++;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
    }
    if (n === 0) return null;

    const pvb = /viewBox="([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)"/.exec(svg);
    if (!pvb) return null;
    const pageW = parseFloat(pvb[3]), pageH = parseFloat(pvb[4]);
    const cw = maxX - minX, ch = maxY - minY;
    if (!(cw > 0 && ch > 0)) return null;
    // Already (nearly) full-bleed → nothing to gain from cropping.
    if (cw >= pageW * 0.92 && ch >= pageH * 0.92) return null;

    const pad = Math.max(cw, ch) * 0.03;
    const vb = `${(minX - pad).toFixed(1)} ${(minY - pad).toFixed(1)} ${(cw + pad * 2).toFixed(1)} ${(ch + pad * 2).toFixed(1)}`;
    let out = svg.replace(/(<svg\b[^>]*?)\sviewBox="[^"]*"/, `$1 viewBox="${vb}"`);
    // Strip the page-sized width/height from the root <svg> only (the leading
    // \s guard skips `stroke-width`; child <rect> width/height keep their own
    // attrs since this replaces just the first, svg-tag, occurrence).
    out = out.replace(/(<svg\b[^>]*?)\swidth="[^"]*"/, "$1");
    out = out.replace(/(<svg\b[^>]*?)\sheight="[^"]*"/, "$1");
    return out === svg ? null : out;
  } catch {
    return null;
  }
}

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
  // For LibreOffice page-export SVGs, crop the viewBox to the drawn content
  // so the diagram fills the frame instead of floating tiny on a full page.
  // Falls back to the original bytes for raster images and uncroppable SVGs.
  const cropped = hit.mimeType === "image/svg+xml" ? cropPageSvg(hit.data) : null;
  const src = cropped !== null ? new TextEncoder().encode(cropped) : hit.data;
  // Copy into a fresh Uint8Array: forces a non-shared ArrayBuffer so the
  // value narrows to the BodyInit-compatible type (TS 5.7+ rejects Node's
  // Buffer / `ArrayBufferLike`-backed views). One extra memcpy per image
  // (≤ ~75 KB for a typical SVG; negligible).
  const body = new Uint8Array(src.byteLength);
  body.set(src);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": hit.mimeType,
      "Content-Length": String(body.byteLength),
      // The corpus SQLite is immutable for a given installed version.
      // Long private cache is safe because the bytes never change for
      // (clauseId, figureId); a new corpus version installs to a
      // fresh path and the desktop reopens the DB anyway.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
