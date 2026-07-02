"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { AlertCircle, GripVertical, Loader2, BookText } from "lucide-react";
import type { TicketDetail, ProductInfo } from "@/lib/types";
import { Logo } from "@/components/ui/Logo";
import Link from "next/link";
import { TicketDetailHeader } from "@/components/detail/TicketDetailHeader";
import { TicketQuickEdit } from "@/components/detail/TicketQuickEdit";
import { TicketDescription } from "@/components/detail/TicketDescription";
import { TicketComments } from "@/components/detail/TicketComments";
import { TicketTimeline } from "@/components/detail/TicketTimeline";
import { TriageChatPanel } from "@/components/triage/TriageChatPanel";

// Resizable split. Stored as the pixel width of the right (AI) panel; the
// left column flexes to fill. Bounded so neither side can collapse below a
// useful width.
const SPLIT_KEY = "triagePanelWidth";
const SPLIT_DEFAULT = 440;
const SPLIT_MIN = 320;
const SPLIT_MAX = 900;

export default function TicketDetailPage() {
  const params = useParams<{ id: string }>();
  const sp = useSearchParams();
  const id = parseInt(params.id);
  const autotriage = sp.get("autotriage") === "1";

  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Option sources for the inline field editor (component dropdown + priority).
  const [productList, setProductList] = useState<ProductInfo[]>([]);
  const [priorityOpts, setPriorityOpts] = useState<string[]>([]);

  // ── Resizable split between ticket context (left) and AI panel (right) ──
  const [asideWidth, setAsideWidth] = useState<number>(SPLIT_DEFAULT);
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(SPLIT_DEFAULT);
  widthRef.current = asideWidth;

  // Read persisted width on mount (after hydration, to avoid SSR mismatch).
  useEffect(() => {
    try {
      const saved = parseInt(localStorage.getItem(SPLIT_KEY) || "");
      if (saved >= SPLIT_MIN && saved <= SPLIT_MAX) setAsideWidth(saved);
    } catch { /* localStorage blocked — fall back to default */ }
  }, []);

  const onDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  // Document-level move/up listeners while dragging. clientX maps to a
  // distance from the container's right edge → that's the desired aside
  // width, clamped to [MIN, MAX].
  useEffect(() => {
    if (!dragging) return;
    const onMove = (ev: PointerEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const next = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, rect.right - ev.clientX));
      setAsideWidth(next);
    };
    const onUp = () => {
      setDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { localStorage.setItem(SPLIT_KEY, String(widthRef.current)); } catch { /* ignore */ }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging]);

  // Double-click resets to the default — quick escape if the user drags
  // themselves into a corner.
  const onResetWidth = useCallback(() => {
    setAsideWidth(SPLIT_DEFAULT);
    try { localStorage.setItem(SPLIT_KEY, String(SPLIT_DEFAULT)); } catch { /* ignore */ }
  }, []);

  // Reused as the post-save refresh (TicketQuickEdit's onSaved): it swaps in
  // the updated ticket WITHOUT flipping `loading`, so an inline field edit
  // reflects in place rather than flashing the full-page spinner.
  const loadTicket = useCallback(async () => {
    try {
      const res = await fetch(`/api/tickets/${id}`);
      const data = await res.json();
      if (data.ticket) setTicket(data.ticket);
      else setError(data.error || "Ticket not found");
      if (data.error && data.ticket) setError(`backend warning: ${data.error}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load ticket");
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    loadTicket().finally(() => setLoading(false));
  }, [loadTicket]);

  // Component + priority option sources for the editor. Effectively static per
  // session; mock-falls-back gracefully so the editor still opens offline (it
  // also merges in the ticket's own current values as a floor).
  useEffect(() => {
    fetch("/api/products")
      .then(r => r.json())
      .then(d => { setProductList(d.products || []); setPriorityOpts(d.priorityOptions || []); })
      .catch(() => { /* editor falls back to the ticket's current values */ });
  }, []);

  const componentOptions = useMemo(
    () => productList.find(p => p.name === ticket?.product)?.components ?? [],
    [productList, ticket?.product],
  );

  return (
    <div className="min-h-screen">
      <header className="border-b border-bg-border bg-bg-panel/60 backdrop-blur-sm sticky top-0 z-20">
        <div className="w-full px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/"><Logo /></Link>
            <div className="text-xs text-slate-500">
              <span className="text-slate-400">Triage Workflow</span>
              <span className="mx-2 text-slate-700">·</span>
              <span>Ticket #{id}</span>
            </div>
          </div>
          {/* Cross-feature glue (v0.5): jump to the 3GPP workbench with this
              ticket's summary pre-loaded as the search. Runs locally — no LLM
              needed — so it works even without a provider configured. */}
          {ticket && (
            <Link
              href={`/spec?q=${encodeURIComponent(ticket.summary)}`}
              className="btn-secondary text-xs py-1.5 px-3"
              title="Search the local 3GPP corpus for clauses related to this ticket (no LLM required)"
            >
              <BookText className="w-3.5 h-3.5" />
              Research in 3GPP
            </Link>
          )}
        </div>
      </header>

      <main className="w-full px-4 sm:px-6 lg:px-8 py-6">
        {loading && (
          <div className="card p-12 flex flex-col items-center gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-accent" />
            <div className="text-sm text-slate-400">Loading ticket #{id}…</div>
          </div>
        )}

        {!loading && error && !ticket && (
          <div className="card p-12 text-center space-y-3 border-red-500/30">
            <AlertCircle className="w-8 h-8 text-red-400 mx-auto" />
            <div className="text-base text-slate-200 font-medium">Could not load ticket</div>
            <div className="text-sm text-slate-500">{error}</div>
            <Link href="/" className="btn-secondary mt-3 inline-flex">Back to dashboard</Link>
          </div>
        )}

        {!loading && ticket && (
          // CSS var lets us mix Tailwind's responsive `grid-cols-1` (mobile,
          // stacked) with a user-resized 3-column grid above the `xl:`
          // breakpoint (left content · drag handle · AI panel). On mobile
          // the handle column is hidden and the panel stacks below.
          <div
            ref={containerRef}
            className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_12px_var(--aside-w,440px)] gap-5 xl:gap-0 animate-fade-in"
            style={{ ["--aside-w" as string]: `${asideWidth}px` } as React.CSSProperties}
          >
            {/* Left/main: ticket context */}
            <div className="space-y-4 min-w-0 xl:pr-5">
              {error && (
                <div className="card border-amber-500/30 bg-amber-950/10 p-3 text-xs text-amber-300">
                  {error}
                </div>
              )}
              <TicketDetailHeader ticket={ticket} />
              <TicketQuickEdit
                ticket={ticket}
                componentOptions={componentOptions}
                priorityOptions={priorityOpts}
                onSaved={loadTicket}
              />
              <TicketDescription ticket={ticket} />
              <TicketComments comments={ticket.comments} />
              <TicketTimeline history={ticket.history} />
            </div>

            {/* Drag handle — only visible on xl+. Sticky so it remains
                reachable as the left column scrolls. Double-click resets. */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize AI panel"
              onPointerDown={onDragStart}
              onDoubleClick={onResetWidth}
              title="Drag to resize · double-click to reset"
              className={`hidden xl:flex items-center justify-center cursor-col-resize select-none
                          sticky top-20 self-start h-[calc(100vh-6rem)] group ${
                dragging ? "z-30" : "z-10"
              }`}
            >
              <div className={`w-[3px] h-full rounded-full transition-colors ${
                dragging
                  ? "bg-accent shadow-[0_0_12px_-2px_rgba(168,85,247,0.7)]"
                  : "bg-bg-border group-hover:bg-accent/60"
              }`} />
              <GripVertical
                className={`absolute w-3.5 h-3.5 transition-colors ${
                  dragging ? "text-accent" : "text-slate-600 group-hover:text-accent/80"
                }`}
              />
            </div>

            {/* Right: sticky AI triage chat panel */}
            <aside className="xl:sticky xl:top-20 xl:self-start xl:h-[calc(100vh-6rem)] xl:pl-5">
              <TriageChatPanel
                ticketId={ticket.id}
                ticketStatus={ticket.status}
                ticketSummary={ticket.summary}
                autotriage={autotriage}
              />
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}
