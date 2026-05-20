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

interface ClauseResponse {
  clauseId: string;
  citation: string;
  title: string;
  parentTitle?: string;
  text: string;
}

interface Props {
  /** When set, drawer is open and a fetch is kicked off for this citation.
   *  Pass null/undefined to close. */
  citation: string | null;
  onClose: () => void;
}

export function SpecDrawer({ citation, onClose }: Props) {
  const [clause, setClause] = useState<ClauseResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

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

      {/* The drawer itself — fixed to the right, full height. */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={clause ? `Spec clause ${clause.citation}` : "Spec clause"}
        className="fixed top-0 right-0 bottom-0 z-50 w-full max-w-2xl
                   bg-bg-panel border-l border-bg-border shadow-2xl
                   flex flex-col animate-slide-up"
      >
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

          {clause && <ClauseBody text={clause.text} />}
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

/** Render a clause body, lifting the parser's pipe-separated table rows
 *  (`| cell | cell | cell`) back into HTML <table>s. The parser flattens
 *  DOCX tables to that shape for FTS-text purposes, so out of the box a
 *  table renders as a wall of pipes in a <pre>. We split the body into
 *  alternating prose/table segments and render each appropriately. */
function ClauseBody({ text }: { text: string }) {
  const segments = parseClauseSegments(text);
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
    </div>
  );
}

function ClauseTable({ rows }: { rows: string[][] }) {
  if (rows.length === 0) return null;
  // Treat the first row as the header when it has at least 2 cells and
  // any cell contains a non-numeric token (typical of header labels);
  // otherwise render all rows as <tbody>.
  const firstLooksLikeHeader =
    rows[0].length >= 2 &&
    rows[0].some(c => /[A-Za-z]{2,}/.test(c));
  const head = firstLooksLikeHeader ? rows[0] : null;
  const body = firstLooksLikeHeader ? rows.slice(1) : rows;
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
          {body.map((row, i) => (
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
          ))}
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
