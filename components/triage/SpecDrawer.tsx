"use client";

// ──────────────────────────────────────────────────────────────────
// SpecDrawer — right-side overlay that renders the full text of a
// single 3GPP clause from the local corpus.
//
// Triggered from the TriageChatPanel's "Initial classification" bubble
// (M3): each spec reference with a corpus-matched `clauseId` shows a
// "View clause" button that opens this drawer. Behavior:
//
//   - Slides in from the right over the ticket detail's right aside;
//     does not disturb the existing split / chat history.
//   - Renders: citation header, parent breadcrumb (when present),
//     clause title, preformatted clause text. Long text scrolls in
//     a viewport-fit container.
//   - Buttons: Copy (text-only, no header), Open spec on 3GPP.org
//     (external link), Close (X / Escape key).
//   - Loads its content lazily via GET /api/corpus/lookup?clause=...
//     when opened, so the parent component just passes the citation
//     and doesn't need to pre-fetch.
//
// Accessibility:
//   - role="dialog" + aria-modal="true"
//   - Initial focus on the close button so Escape works immediately
//   - Body-scroll lock while open (rare for an overlay this size,
//     but matches what triage users expect from inspector drawers)
// ──────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { X, Copy, CheckCircle2, ExternalLink, Loader2, AlertCircle, BookText } from "lucide-react";

interface ClauseTableData {
  id: string;
  caption: string;
  rows: string[][];
}

interface ClauseFigureData {
  id: string;
  caption: string;
  /** Source media filename inside the corpus build — populated only on
   *  v3 corpora (rel17-v4+). When present AND the matching
   *  ClauseFigureImage entry exists, the drawer renders an inline
   *  `<img>`. */
  mediaFilename?: string;
}

interface ClauseFigureImage {
  figureId: string;
  mimeType: string;
  bytes: number;
}

interface ClauseResponse {
  clauseId: string;
  citation: string;
  title: string;
  parentTitle?: string;
  text: string;
  tables?: ClauseTableData[];
  figures?: ClauseFigureData[];
  /** v3-only — figure-image metadata. Empty on v1/v2 corpora. Each
   *  entry's `figureId` matches a ClauseFigureData.id in `figures`. */
  figureImages?: ClauseFigureImage[];
  matchedAs?: "exact" | "ancestor";
  /** When matchedAs === "ancestor", the original (parent / non-leaf)
   *  id the user clicked. The drawer shows a hint so it's obvious the
   *  citation in the header differs from what was clicked. */
  requestedClauseId?: string;
}

interface Props {
  /** When set, drawer is open and a fetch is kicked off for this citation.
   *  Pass null/undefined to close. */
  citation: string | null;
  onClose: () => void;
}

// Drawer width bounds. The min keeps the spec citation header legible
// (~360 px is the narrowest where 3-letter Copy / View buttons still fit
// alongside the citation chip). The max stops at viewport-width minus
// a small gutter so a click-outside backdrop area always remains.
const DRAWER_MIN_WIDTH = 360;
const DRAWER_MAX_WIDTH_GUTTER = 80;   // px reserved on the left
const DRAWER_DEFAULT_WIDTH = 672;     // matches old `max-w-2xl`
// LocalStorage key — survives reloads so a user who widens the drawer
// once doesn't have to re-drag every session. Keyed under the spec
// namespace so future drawers (e.g. an attachment viewer) can have
// their own preferences.
const DRAWER_WIDTH_LS_KEY = "bugzilla-triage:spec-drawer:width";

export function SpecDrawer({ citation, onClose }: Props) {
  const [clause, setClause] = useState<ClauseResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // ── Resizable width ──────────────────────────────────────────────
  // Restore the user's last drag width on mount (clamped to current
  // viewport in case they shrank the window between sessions). Falls
  // back to DRAWER_DEFAULT_WIDTH when the storage key is missing or
  // unreadable (private-mode browsers, first-ever open, etc.).
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return DRAWER_DEFAULT_WIDTH;
    try {
      const stored = parseInt(localStorage.getItem(DRAWER_WIDTH_LS_KEY) || "", 10);
      if (!Number.isFinite(stored) || stored < DRAWER_MIN_WIDTH) return DRAWER_DEFAULT_WIDTH;
      const max = Math.max(DRAWER_MIN_WIDTH, window.innerWidth - DRAWER_MAX_WIDTH_GUTTER);
      return Math.min(stored, max);
    } catch {
      return DRAWER_DEFAULT_WIDTH;
    }
  });
  // Drag state. We track in a ref instead of state because the
  // mousemove handler fires at 60 Hz; setting React state per frame
  // is wasteful and adds noticeable latency to the drag.
  const dragRef = useRef<{ active: boolean; startX: number; startWidth: number }>({
    active: false, startX: 0, startWidth: 0,
  });

  const onResizeStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragRef.current = { active: true, startX: e.clientX, startWidth: width };
    // While dragging, lock the cursor + suppress text selection across
    // the whole page so the user can drag freely past the drawer.
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
  }, [width]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current.active) return;
      // Drag-handle is on the LEFT edge of the right-anchored drawer.
      // Moving the mouse LEFT (lower clientX) widens the drawer; moving
      // RIGHT narrows it. dx therefore subtracts from the start width.
      const dx = e.clientX - dragRef.current.startX;
      const newW = dragRef.current.startWidth - dx;
      const max = Math.max(DRAWER_MIN_WIDTH, window.innerWidth - DRAWER_MAX_WIDTH_GUTTER);
      setWidth(Math.max(DRAWER_MIN_WIDTH, Math.min(max, newW)));
    };
    const onUp = () => {
      if (!dragRef.current.active) return;
      dragRef.current.active = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // Persist on drop, not every frame — fewer storage writes.
      try { localStorage.setItem(DRAWER_WIDTH_LS_KEY, String(width)); } catch { /* private mode */ }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [width]);

  // Persist on window resize so a viewport shrink doesn't leave the
  // drawer wider than the page. We re-clamp but keep the user's
  // preference intact: when they grow the viewport back, the drawer
  // returns to their last drag width.
  useEffect(() => {
    const onResize = () => {
      const max = Math.max(DRAWER_MIN_WIDTH, window.innerWidth - DRAWER_MAX_WIDTH_GUTTER);
      setWidth(w => Math.min(w, max));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Open/close lifecycle: when `citation` changes, refetch.
  useEffect(() => {
    if (!citation) {
      // Drawer is closed — clear state so the next open starts fresh.
      setClause(null);
      setError(null);
      return;
    }
    setLoading(true);
    setClause(null);
    setError(null);
    fetch(`/api/corpus/lookup?clause=${encodeURIComponent(citation)}`)
      .then(async r => {
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        return (await r.json()) as ClauseResponse;
      })
      .then(setClause)
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [citation]);

  // Escape closes; focus the close button on open so keyboard users
  // don't need a mouse to dismiss.
  useEffect(() => {
    if (!citation) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    closeBtnRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [citation, onClose]);

  // Body-scroll lock while drawer is open.
  useEffect(() => {
    if (!citation) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [citation]);

  const onCopy = useCallback(() => {
    if (!clause) return;
    navigator.clipboard.writeText(clause.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard blocked — ignore quietly */ });
  }, [clause]);

  // The "open on 3GPP.org" link points at the spec landing page — 3GPP's
  // archive URLs don't have stable per-clause anchors, but the spec page
  // is one click away from the latest version download.
  const externalUrl = clause ? specLandingUrl(clause.citation) : null;

  if (!citation) return null;

  return (
    <>
      {/* Backdrop — clicking it closes the drawer. */}
      <div
        className="fixed inset-0 z-40 bg-black/40 dark:bg-black/60 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* The drawer itself — fixed to the right, full height. Width is
          user-resizable via the drag handle on its left edge; restored
          from localStorage so the choice persists across sessions. */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={clause ? `Spec clause ${clause.citation}` : "Spec clause"}
        className="fixed top-0 right-0 bottom-0 z-50
                   bg-bg-panel border-l border-bg-border shadow-2xl
                   flex flex-col animate-slide-up"
        style={{ width: `${width}px`, maxWidth: "100vw" }}
      >
        {/* Drag handle on the LEFT edge — a 6 px-wide invisible grab
            zone with a 1 px visible spine. Hovering reveals an accent
            stripe to telegraph that it's interactive; on grab, the
            page-wide cursor + selection-suppress in onResizeStart keeps
            the drag smooth even when the mouse leaves the handle. */}
        <div
          onMouseDown={onResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize spec drawer"
          aria-valuemin={DRAWER_MIN_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          title={`Drag to resize · ${width} px`}
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize
                     bg-transparent hover:bg-accent/40 active:bg-accent/70
                     transition-colors z-10
                     before:content-[''] before:absolute before:inset-y-0
                     before:left-0 before:w-px before:bg-bg-border"
        />
        {/* Header */}
        <div className="flex items-start gap-3 p-4 border-b border-bg-border bg-bg-card">
          <div className="w-8 h-8 rounded-md bg-gradient-to-br from-accent to-fuchsia-600 flex items-center justify-center shrink-0">
            <BookText className="w-4 h-4 text-white" strokeWidth={2.5} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">
              3GPP Rel-17 corpus
            </div>
            <div className="text-sm font-mono font-semibold text-slate-100 break-words">
              {citation}
            </div>
            {clause?.title && (
              <div className="text-xs text-slate-300 mt-0.5 truncate" title={clause.title}>
                {clause.title}
              </div>
            )}
            {clause?.parentTitle && (
              <div className="text-[11px] text-slate-500 mt-0.5 truncate" title={clause.parentTitle}>
                within: {clause.parentTitle}
              </div>
            )}
          </div>
          <button
            ref={closeBtnRef}
            onClick={onClose}
            className="btn-ghost p-1.5 shrink-0"
            title="Close (Esc)"
            aria-label="Close drawer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Ancestor-match hint — shown when the requested citation was a
            non-leaf section and we resolved to its first descendant leaf. */}
        {clause?.matchedAs === "ancestor" && clause.requestedClauseId && (
          <div className="px-4 py-2 border-b border-bg-border/40 bg-amber-500/5 text-[11px] text-amber-200/80 flex items-start gap-2">
            <span className="font-mono shrink-0">ℹ︎</span>
            <span>
              The cited reference <span className="font-mono">{clause.requestedClauseId.replace("#", " §")}</span> is a parent section. Showing its first leaf clause <span className="font-mono">{clause.clauseId.replace("#", " §")}</span>.
            </span>
          </div>
        )}

        {/* Body — fetch state machine */}
        <div className="flex-1 overflow-y-auto p-4 min-h-0">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <Loader2 className="w-4 h-4 animate-spin text-accent" />
              Loading clause from local corpus…
            </div>
          )}

          {error && (
            <div className="card border-red-500/30 bg-red-950/20 p-3 text-sm text-red-300 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <div className="break-words">
                <div className="font-medium">Couldn&apos;t load clause</div>
                <div className="text-xs text-slate-400 mt-1">{error}</div>
                <div className="text-[11px] text-slate-500 mt-2">
                  This can happen when the corpus isn&apos;t downloaded yet
                  (open Settings → Spec corpus) or when the model cited a
                  clause that isn&apos;t in the Rel-17 corpus.
                </div>
              </div>
            </div>
          )}

          {clause && <ClauseBody clause={clause} />}
        </div>

        {/* Footer */}
        <div className="border-t border-bg-border p-3 bg-bg-card flex items-center gap-2 flex-wrap">
          <button
            onClick={onCopy}
            disabled={!clause}
            className="btn-secondary text-xs"
            title="Copy clause text"
          >
            {copied ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
          {externalUrl && (
            <a
              href={externalUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="btn-ghost text-xs"
              title="Open spec on 3GPP.org (external)"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open on 3GPP.org
            </a>
          )}
          <div className="ml-auto text-[10px] text-slate-500">
            Esc to close
          </div>
        </div>
      </aside>
    </>
  );
}

/** Map a citation like "3GPP TS 38.211 §6.3.1.1" to the spec landing
 *  page on 3gpp.org. 3GPP's archive URLs don't have stable per-clause
 *  anchors, but the per-spec directory is what users usually want. */
function specLandingUrl(citation: string): string | null {
  const m = citation.match(/TS\s+(\d+)\.(\d+(?:-\d+)?)/i);
  if (!m) return null;
  const series = m[1];
  const spec = `${series}.${m[2]}`;
  return `https://www.3gpp.org/ftp/Specs/archive/${series}_series/${spec}/`;
}

/** Render a clause body. When the v2 corpus's structured `tables` array
 *  is present, we render it as real HTML <table>s and strip the broken
 *  pipe-row leftovers from the flattened text. Otherwise (v1 corpus, or
 *  a clause without structured tables) we fall back to the old
 *  text-only render with a heuristic pipe-row → table parser. */
function ClauseBody({ clause }: { clause: ClauseResponse }) {
  const hasStructuredTables = (clause.tables?.length ?? 0) > 0;
  if (hasStructuredTables) {
    const cleaned = stripFigureCaptionLines(
      cleanClauseBody(clause.text, clause.tables!),
      clause.figures,
    );
    // Interleave each structured table directly after its "Table N: …" title
    // line in the prose, so a table sits with its name instead of all titles
    // bunching at the top and all tables at the bottom. Returns null (→ the
    // old all-prose-then-all-tables layout) when the title lines don't map
    // 1:1 to the tables, so we never mis-pair.
    const segments = interleaveTables(cleaned, clause.tables!);
    return (
      <div className="text-xs text-slate-200 leading-relaxed space-y-3">
        {segments ? (
          segments.map((seg, i) =>
            seg.kind === "table" ? (
              <div key={i}>
                {seg.caption && (
                  <div className="text-[11px] text-slate-400 font-medium mb-1">
                    {seg.caption}
                  </div>
                )}
                <ClauseTable rows={seg.rows} />
              </div>
            ) : (
              <pre key={i} className="whitespace-pre-wrap font-mono leading-relaxed">
                {seg.text}
              </pre>
            ),
          )
        ) : (
          <>
            {cleaned && (
              <pre className="whitespace-pre-wrap font-mono leading-relaxed">
                {cleaned}
              </pre>
            )}
            {clause.tables!.map((t, i) => (
              <div key={t.id || i}>
                {t.caption && (
                  <div className="text-[11px] text-slate-400 font-medium mb-1">
                    {t.caption}
                  </div>
                )}
                <ClauseTable rows={t.rows} />
              </div>
            ))}
          </>
        )}
        <ClauseFigures clause={clause} />
      </div>
    );
  }
  // Fallback: parse pipe-row segments client-side (v1 corpus path, and v3
  // clauses that have figures but no tables — e.g. 38.101-1 §6.3.3.6).
  const segments = parseClauseSegments(stripFigureCaptionLines(clause.text, clause.figures));
  return (
    <div className="text-xs text-slate-200 leading-relaxed space-y-3">
      {segments.map((seg, i) =>
        seg.kind === "table" ? (
          <ClauseTable key={i} rows={seg.rows} />
        ) : (
          <pre
            key={i}
            className="whitespace-pre-wrap font-mono leading-relaxed"
          >
            {seg.text}
          </pre>
        ),
      )}
      {/* Figures render regardless of whether the clause has tables — a
          figures-only clause (e.g. 38.101-1 §6.3.3.6) still lands here. */}
      <ClauseFigures clause={clause} />
    </div>
  );
}

/** The inline Figures section: pairs each `figures_json` caption with its
 *  image blob (served by /api/corpus/figure) and renders SVG/PNG/JPEG
 *  uniformly. Shown for ANY clause that has figures — extracted from the
 *  structured-tables branch so figures-only clauses (no tables) render them
 *  too. Captions with no blob show a "caption only" hint. */
function ClauseFigures({ clause }: { clause: ClauseResponse }) {
  if ((clause.figures?.length ?? 0) === 0) return null;
  return (
    <div className="space-y-3 pt-2 border-t border-bg-border/30">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-0.5">
        Figures
      </div>
      {clause.figures!.map((f, i) => {
        // Pair the caption with the v3 image-blob entry. The figure_id used
        // in the API URL matches the figure's `id` field exactly (composite
        // of clauseId + Figure-N).
        const hasImage = (clause.figureImages ?? []).some(img => img.figureId === f.id);
        const captionShort = f.id.split("/").pop();
        return (
          <figure
            key={f.id || i}
            className="bg-bg-panel/40 rounded-md border border-bg-border/40 overflow-hidden"
          >
            {hasImage && (
              // eslint-disable-next-line @next/next/no-img-element --
              // proxy URL pattern with dynamic clauseId/figureId; next/image
              // can't precompute these. The native <img> handles
              // SVG/PNG/JPEG uniformly and the browser respects our private
              // cache header.
              <img
                src={
                  `/api/corpus/figure?clauseId=${encodeURIComponent(clause.clauseId)}` +
                  `&figureId=${encodeURIComponent(f.id)}`
                }
                alt={f.caption || captionShort || "figure"}
                className="w-full max-h-[480px] object-contain bg-white/95 p-2"
                loading="lazy"
                onError={e => {
                  // Retry once before giving up: a transient failure (server
                  // restarting, momentary blip) would otherwise permanently
                  // hide a figure whose blob is perfectly fine, until reload.
                  // The cache-buster forces a fresh request past any cached
                  // error. Only a genuine 404 (image not in corpus) hides it
                  // — and the caption row below still renders either way.
                  const img = e.currentTarget as HTMLImageElement;
                  if (img.dataset.retried) {
                    img.style.display = "none";
                    return;
                  }
                  img.dataset.retried = "1";
                  const sep = img.src.includes("?") ? "&" : "?";
                  img.src = `${img.src}${sep}_retry=1`;
                }}
              />
            )}
            <figcaption className="px-2 py-1.5 text-[11px] text-slate-400 italic border-t border-bg-border/30 bg-bg-panel/80">
              <span className="font-mono not-italic text-slate-300">
                {captionShort}
              </span>
              {f.caption && <span>: {f.caption}</span>}
              {!hasImage && (
                <span className="ml-2 text-slate-600 not-italic">
                  (caption only — image not in corpus)
                </span>
              )}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}

type BodySegment =
  | { kind: "prose"; text: string }
  | { kind: "table"; caption: string; rows: string[][] };

/** Matches a 3GPP table TITLE line — "Table 8.20.2.1-1: <name>" — at the
 *  start of a line. Case-sensitive capital "Table" + a number token + colon,
 *  so it won't catch mid-sentence inline references ("as shown in table
 *  8.20.2.1-5 …"). */
const TABLE_TITLE_RE = /^Table\s+[\w.\-]+\s*:/;

/** Interleave the structured tables into the prose at their title lines, so
 *  each table renders right under its "Table N: …" heading instead of all
 *  titles stacking at the top and all tables at the bottom (the disconnect
 *  the user hit on multi-table clauses like 36.133 §8.20.2.1, 9 tables).
 *
 *  The title line becomes the table's caption (it carries the full, correct
 *  "Table N: <name>" — better than the often-mangled `tables[i].caption`,
 *  e.g. a stray "a: …"). Tables are matched to title lines positionally, in
 *  document order. Returns null when the count of title lines ≠ the count of
 *  tables, so the caller falls back to the safe stacked layout rather than
 *  risk pairing a table with the wrong heading. */
function interleaveTables(
  cleaned: string,
  tables: { id?: string; caption?: string; rows: string[][] }[],
): BodySegment[] | null {
  if (tables.length === 0) return null;
  const lines = cleaned.split("\n");
  const titleIdxs = lines
    .map((ln, i) => (TABLE_TITLE_RE.test(ln.trim()) ? i : -1))
    .filter(i => i >= 0);
  if (titleIdxs.length !== tables.length) return null;

  const flush = (from: number, to: number): string =>
    lines.slice(from, to).join("\n").replace(/\n{3,}/g, "\n\n").trim();

  const segs: BodySegment[] = [];
  let cursor = 0;
  titleIdxs.forEach((idx, t) => {
    const prose = flush(cursor, idx);
    if (prose) segs.push({ kind: "prose", text: prose });
    segs.push({ kind: "table", caption: lines[idx].trim(), rows: tables[t].rows });
    cursor = idx + 1;
  });
  const tail = flush(cursor, lines.length);
  if (tail) segs.push({ kind: "prose", text: tail });
  return segs;
}

/** Drop standalone "Figure N: <caption>" title lines from the body text —
 *  they're rendered (with the image) in the Figures section, so leaving them
 *  in the prose duplicates the caption. Only strips lines that START with
 *  "Figure <num>:", so inline references ("… ; See Figure 6.3.3.6-1") that
 *  point the reader at a figure are preserved. No-op when the clause has no
 *  figures. */
function stripFigureCaptionLines(
  text: string,
  figures?: { id?: string; caption?: string }[],
): string {
  if (!figures || figures.length === 0) return text;
  return text
    .split("\n")
    .filter(ln => !/^\s*Figure\s+[\w.\-]+\s*:/i.test(ln))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Clean the flattened clause text for the body `<pre>`. Drops:
 *   1. Pipe-row leftovers (`| cell | cell`) — they're rendered as the real
 *      structured <table> instead.
 *   2. "NOTE N:" prose lines whose number also appears in a table's NOTE
 *      row — otherwise the same notes show twice (as prose before the table,
 *      and as the table's note section after it). 3GPP packs all of a
 *      table's notes into one concatenated NOTE cell ("NOTE 1: … NOTE 2: …"),
 *      so we match by note NUMBER, not full text. A "NOTE N:" line whose
 *      number isn't under any table stays in the body.
 *  Conservative on (1): only matches lines whose first non-whitespace char
 *  is `|`, so prose containing literal pipes mid-sentence survives. */
function cleanClauseBody(text: string, tables: { rows: string[][] }[]): string {
  const tableNoteNums = new Set<string>();
  for (const t of tables) {
    for (const row of t.rows) {
      if (!isNoteRow(row)) continue;
      for (const m of (row[0] || "").matchAll(/\bNOTE\s+(\d+)\s*[:.]/gi)) {
        tableNoteNums.add(m[1]);
      }
    }
  }
  return text
    .split("\n")
    .filter(ln => !/^\s*\|/.test(ln))
    .filter(ln => {
      const m = ln.match(/^\s*NOTE\s+(\d+)\s*[:.]/i);
      return !(m && tableNoteNums.has(m[1]));
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 3GPP NOTE rows live at the bottom of most spec tables and have the
 *  shape ["NOTE 1: text…", "", "", …] — i.e. the prose lives in the
 *  first cell and all remaining cells are empty padding. Rendered
 *  naively, the prose gets crammed into the first column's width
 *  (which is sized for short band names like "n95 8"), producing the
 *  awkward 1-word-per-line wrap shown in the user's screenshot.
 *
 *  Detection: first cell starts with the literal "NOTE" (optionally
 *  followed by digits + colon) AND every subsequent cell is blank.
 *  Case-insensitive on the keyword so we also catch "Note:" or
 *  "NOTE:" variants seen in older specs. */
function isNoteRow(row: string[]): boolean {
  if (row.length === 0) return false;
  const first = (row[0] || "").trim();
  if (!/^note\b/i.test(first)) return false;
  return row.slice(1).every(c => !c || !c.trim());
}

function ClauseTable({ rows }: { rows: string[][] }) {
  if (rows.length === 0) return null;
  // Treat the first row as the header when it has at least 2 cells and
  // any cell contains a non-numeric token (typical of header labels);
  // otherwise render all rows as <tbody>. NOTE rows are excluded from
  // this check — a table that happens to start with a NOTE row (rare
  // but happens for amended tables) won't get the note treated as a
  // header.
  const firstLooksLikeHeader =
    !isNoteRow(rows[0]) &&
    rows[0].length >= 2 &&
    rows[0].some(c => /[A-Za-z]{2,}/.test(c));
  const head = firstLooksLikeHeader ? rows[0] : null;
  const body = firstLooksLikeHeader ? rows.slice(1) : rows;
  // colSpan for NOTE rows = the widest row in the table. Use the head
  // width when present, else the max across body rows (3GPP tables are
  // sometimes ragged at the right edge).
  const maxCols = Math.max(
    head?.length ?? 0,
    ...body.map(r => r.length),
    1,
  );
  return (
    <div className="overflow-x-auto border border-bg-border rounded">
      <table className="text-[11px] w-full">
        {head && (
          <thead className="bg-bg-card/60">
            <tr>
              {head.map((c, j) => (
                <th
                  key={j}
                  className="px-2 py-1 text-left font-semibold text-slate-200 border-b border-bg-border whitespace-nowrap"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((row, i) => {
            // NOTE rows span the entire table — restores the original
            // 3GPP layout where the note prose flows under the table
            // body, not constrained to the first column. Subtle visual
            // distinction (italic + slightly lighter background) helps
            // the reader pick them out at a glance.
            if (isNoteRow(row)) {
              // The DOCX parser frequently concatenates multiple notes
              // into one cell separated only by spaces, producing
              // "NOTE 1: text. NOTE 2: text. NOTE 3: …" which reads as
              // a single dense paragraph. Split on the NOTE-marker
              // boundary so each note renders on its own paragraph
              // line. Lookahead-only so the marker stays attached to
              // its prose. Tolerant of "NOTE", "Note", colon or period
              // (older 3GPP styles).
              const noteSegments = (row[0] || "")
                .split(/(?=\bNOTE\s+\d+\s*[:.])/gi)
                .map(s => s.trim())
                .filter(Boolean);
              return (
                <tr key={i} className="bg-bg-card/40">
                  <td
                    colSpan={maxCols}
                    className="px-3 py-2 text-slate-400 italic border-b border-bg-border/40 align-top space-y-1.5"
                  >
                    {noteSegments.length > 1
                      ? noteSegments.map((seg, k) => (
                          // Hanging indent so "NOTE N:" stays visually
                          // distinct from its continuation lines.
                          <div key={k} className="pl-12 -indent-12">
                            {seg}
                          </div>
                        ))
                      : (
                          // Single-note row — no need for the split
                          // treatment; whitespace-pre-wrap preserves
                          // any embedded line breaks from the source.
                          <div className="whitespace-pre-wrap">{row[0]}</div>
                        )
                    }
                  </td>
                </tr>
              );
            }
            return (
              <tr key={i} className="even:bg-bg-card/30">
                {row.map((c, j) => (
                  <td
                    key={j}
                    className="px-2 py-1 text-slate-300 border-b border-bg-border/40 align-top"
                  >
                    {c}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type Segment =
  | { kind: "text"; text: string }
  | { kind: "table"; rows: string[][] };

/** Walk the flattened clause text line by line. A run of consecutive
 *  lines that look like table rows (start with `|`, contain ≥ 2 cells)
 *  gets collapsed into a single `table` segment. Everything else is
 *  preserved verbatim as `text` (paragraphs, list bullets, etc.). */
function parseClauseSegments(text: string): Segment[] {
  const out: Segment[] = [];
  const lines = text.split("\n");
  let textBuf: string[] = [];
  let tableBuf: string[][] = [];

  const flushText = () => {
    if (textBuf.length === 0) return;
    out.push({ kind: "text", text: textBuf.join("\n") });
    textBuf = [];
  };
  const flushTable = () => {
    if (tableBuf.length === 0) return;
    out.push({ kind: "table", rows: tableBuf });
    tableBuf = [];
  };

  for (const raw of lines) {
    const cells = tryParseTableRow(raw);
    if (cells) {
      flushText();
      tableBuf.push(cells);
    } else {
      flushTable();
      textBuf.push(raw);
    }
  }
  flushText();
  flushTable();
  return out;
}

/** A table row in the parser's flattened format looks like:
 *    "| cell1 | cell2 | cell3"
 *  (leading whitespace optional, trailing pipe optional). We require at
 *  least two cells to avoid false positives on prose containing a single
 *  literal pipe (e.g. command-line examples). */
function tryParseTableRow(line: string): string[] | null {
  // Quick reject: must contain at least 2 pipes after the leading edge.
  if ((line.match(/\|/g) || []).length < 2) return null;
  // Strip leading whitespace + the opening pipe.
  const trimmed = line.replace(/^\s*\|\s?/, "");
  if (trimmed === line) return null;       // no leading pipe → not a row
  const parts = trimmed.split(/\s*\|\s*/).map(s => s.trim());
  // Drop a trailing empty cell from `... | row | ` artefacts.
  while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  if (parts.length < 2) return null;
  return parts;
}
