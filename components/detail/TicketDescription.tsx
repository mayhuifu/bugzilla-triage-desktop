"use client";

import { useEffect, useState } from "react";
import { FileText, Paperclip, Image as ImageIcon, Link as LinkIcon, X, Download } from "lucide-react";
import type { TicketDetail, TicketAttachment } from "@/lib/types";

// Bugzilla helper's per-attachment size cap — keep in sync with
// MAX_INLINE_FETCH_BYTES in lib/bugzilla.ts → attachments(). Files above
// this won't load through the proxy route, so the component skips
// fetching their bytes and falls back to a file icon.
const MAX_INLINE_SIZE = 5_000_000;
const IMAGE_RE = /^image\//i;

/** True if this attachment's content-type starts with "image/" AND the
 *  size is small enough to load through the proxy route. Tickets
 *  occasionally have 50-MB schematic PNGs — we keep showing those as
 *  a file icon rather than letting the browser silently fail. */
function isInlineableImage(a: TicketAttachment): boolean {
  return IMAGE_RE.test(a.contentType) && a.size > 0 && a.size <= MAX_INLINE_SIZE;
}

export function TicketDescription({ ticket }: { ticket: TicketDetail }) {
  // `zoomed` is the attachment object the user clicked. When non-null we
  // render a full-screen overlay with the larger preview. ESC closes it
  // (set up in a useEffect below).
  const [zoomed, setZoomed] = useState<TicketAttachment | null>(null);

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomed(null);
    };
    window.addEventListener("keydown", onKey);
    // Lock body scroll while the lightbox is open — otherwise scrolling
    // the underlying ticket detail leaks through and feels janky.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [zoomed]);

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <FileText className="w-4 h-4 text-accent" />
        <div className="text-sm font-medium text-slate-200">Description</div>
      </div>
      <pre className="text-sm text-slate-300 whitespace-pre-wrap font-mono leading-relaxed bg-bg-panel/60 rounded-lg p-4 border border-bg-border/60 max-h-96 overflow-auto">
        {ticket.description || <span className="text-slate-500">(no description)</span>}
      </pre>

      {(ticket.blocks.length > 0 || ticket.dependsOn.length > 0) && (
        <div className="grid grid-cols-2 gap-3 text-xs">
          {ticket.dependsOn.length > 0 && (
            <div className="bg-bg-panel/40 rounded-lg p-3 border border-bg-border/40">
              <div className="flex items-center gap-1 text-slate-500 mb-1.5">
                <LinkIcon className="w-3 h-3" />
                Depends on
              </div>
              <div className="font-mono text-slate-300">{ticket.dependsOn.join(", ")}</div>
            </div>
          )}
          {ticket.blocks.length > 0 && (
            <div className="bg-bg-panel/40 rounded-lg p-3 border border-bg-border/40">
              <div className="flex items-center gap-1 text-slate-500 mb-1.5">
                <LinkIcon className="w-3 h-3" />
                Blocks
              </div>
              <div className="font-mono text-slate-300">{ticket.blocks.join(", ")}</div>
            </div>
          )}
        </div>
      )}

      {ticket.attachments.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Paperclip className="w-3.5 h-3.5" />
            Attachments ({ticket.attachments.length})
          </div>

          {/* Image attachments: dedicated thumbnail grid above the
              generic file list, since the visual preview IS the most
              useful summary for a screenshot / spectrum plot / schematic. */}
          {ticket.attachments.some(isInlineableImage) && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {ticket.attachments.filter(isInlineableImage).map(a => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setZoomed(a)}
                  className="group relative bg-bg-panel/40 rounded-lg border border-bg-border/40 overflow-hidden hover:border-accent/50 transition-colors text-left focus:outline-none focus:ring-2 focus:ring-accent/60"
                  title={`${a.fileName} · ${fmtBytes(a.size)} · ${a.creator.split("@")[0]}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element --
                      next/image's loader can't be configured for this
                      proxy URL pattern in a useful way (no static
                      dimensions known up front), and the standard <img>
                      tag is fine for a constrained-size thumb. */}
                  <img
                    src={`/api/tickets/${ticket.id}/attachments/${a.id}`}
                    alt={a.fileName}
                    className="w-full h-32 object-cover bg-bg-hover"
                    loading="lazy"
                    onError={e => {
                      // If the proxy 404s (e.g. attachment got pruned
                      // server-side mid-session), swap in a placeholder
                      // glyph so the grid layout doesn't collapse.
                      (e.currentTarget as HTMLImageElement).style.display = "none";
                      const parent = (e.currentTarget as HTMLImageElement).parentElement;
                      if (parent && !parent.querySelector(".img-fallback")) {
                        const fb = document.createElement("div");
                        fb.className = "img-fallback w-full h-32 flex items-center justify-center text-slate-500 text-xs";
                        fb.textContent = "preview unavailable";
                        parent.appendChild(fb);
                      }
                    }}
                  />
                  <div className="px-2 py-1.5 text-[11px] text-slate-400 truncate border-t border-bg-border/40 bg-bg-panel/80">
                    {a.fileName}
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Generic file list — covers non-image attachments AND
              oversized images that can't render through the 5MB-capped
              proxy. Image rows still show the image glyph so the user
              knows what they are. */}
          {ticket.attachments.some(a => !isInlineableImage(a)) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {ticket.attachments.filter(a => !isInlineableImage(a)).map(a => (
                <div key={a.id} className="bg-bg-panel/40 rounded-lg p-3 border border-bg-border/40 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-md bg-bg-hover flex items-center justify-center text-slate-500 shrink-0">
                    {a.contentType.startsWith("image/") ? <ImageIcon className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-slate-200 truncate">{a.fileName}</div>
                    <div className="text-[11px] text-slate-500">
                      {a.contentType} · {fmtBytes(a.size)} · {a.creator.split("@")[0]}
                      {a.size > MAX_INLINE_SIZE && IMAGE_RE.test(a.contentType) && (
                        <span className="ml-1 text-amber-400/80">(too large to preview)</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="text-[11px] text-slate-600 italic">
            Image previews stream through the local proxy. Non-image and oversized files are referenced for context only.
          </div>
        </div>
      )}

      {/* Lightbox overlay — rendered at the top level so it covers the
          whole viewport regardless of where TicketDescription sits in
          the page tree. */}
      {zoomed && (
        <div
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-6 cursor-zoom-out"
          onClick={() => setZoomed(null)}
          role="dialog"
          aria-modal="true"
          aria-label={`Image preview: ${zoomed.fileName}`}
        >
          <button
            type="button"
            onClick={e => { e.stopPropagation(); setZoomed(null); }}
            className="absolute top-4 right-4 p-2 rounded-full bg-bg-panel/80 hover:bg-bg-panel text-slate-200 border border-bg-border"
            title="Close (Esc)"
            aria-label="Close preview"
          >
            <X className="w-4 h-4" />
          </button>
          <a
            href={`/api/tickets/${ticket.id}/attachments/${zoomed.id}`}
            download={zoomed.fileName}
            onClick={e => e.stopPropagation()}
            className="absolute top-4 right-16 p-2 rounded-full bg-bg-panel/80 hover:bg-bg-panel text-slate-200 border border-bg-border inline-flex items-center gap-1.5 text-xs"
            title="Download original"
          >
            <Download className="w-3.5 h-3.5" /> Download
          </a>
          {/* Stop propagation on the image so a stray click on the image
              itself doesn't close — only clicks on the dark backdrop do. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/tickets/${ticket.id}/attachments/${zoomed.id}`}
            alt={zoomed.fileName}
            className="max-w-full max-h-[88vh] object-contain rounded-lg shadow-2xl cursor-default"
            onClick={e => e.stopPropagation()}
          />
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-bg-panel/80 border border-bg-border text-xs text-slate-300">
            {zoomed.fileName} · {fmtBytes(zoomed.size)} · {zoomed.creator.split("@")[0]}
          </div>
        </div>
      )}
    </div>
  );
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
