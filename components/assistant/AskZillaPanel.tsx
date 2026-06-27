"use client";

// AskZillaPanel — the right-docked agentic chat panel on the dashboard.
// Sends the conversation to /api/assistant, renders the assistant's answer +
// tool-activity chips, pushes ticket-search results into the dashboard table
// (via onTickets), and renders WRITE proposals as approval cards. Nothing is
// written to Bugzilla until the user clicks Approve — which POSTs the proposal
// to its existing (audited) endpoint.

import { useEffect, useRef, useState } from "react";
import { Sparkles, X, Send, LoaderCircle, Check, Search, FileText, GitPullRequestArrow } from "lucide-react";
import type { TicketSummary } from "@/lib/types";

interface AgentStep { tool: string; ok: boolean; note: string }
interface Proposal { kind: "comment" | "status" | "file_ticket"; title: string; detail: string; endpoint: string; method: "POST"; body: Record<string, unknown> }
interface Turn {
  role: "user" | "assistant";
  content: string;
  steps?: AgentStep[];
  proposals?: Proposal[];
  ticketCount?: number;
}

type PropState = "pending" | "approving" | "done" | "error" | "dismissed";

const ASK_WIDTH_KEY = "zilla-ask-width";
const MIN_W = 360;
const maxW = () => (typeof window !== "undefined" ? Math.min(window.innerWidth * 0.95, 1000) : 1000);

export function AskZillaPanel({
  open, onClose, onTickets, context, seed,
}: {
  open: boolean;
  onClose: () => void;
  onTickets: (tickets: TicketSummary[]) => void;
  context?: string;
  seed?: string;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [propStatus, setPropStatus] = useState<Record<string, PropState>>({});
  const [propResult, setPropResult] = useState<Record<string, string>>({});
  const [width, setWidth] = useState(460);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Restore the user's chosen panel width.
  useEffect(() => {
    try {
      const w = Number(localStorage.getItem(ASK_WIDTH_KEY));
      if (w >= MIN_W) setWidth(Math.min(w, maxW()));
    } catch { /* private mode */ }
  }, []);

  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const onMove = (ev: MouseEvent) =>
      setWidth(Math.max(MIN_W, Math.min(window.innerWidth - ev.clientX, maxW())));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      setWidth(w => { try { localStorage.setItem(ASK_WIDTH_KEY, String(Math.round(w))); } catch { /* */ } return w; });
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Seed the input from the dashboard search box the first time the panel opens.
  useEffect(() => { if (open && seed && turns.length === 0) setInput(seed); }, [open, seed, turns.length]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [turns, busy]);

  if (!open) return null;

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setError(null);
    const history: Turn[] = [...turns, { role: "user", content: text }];
    setTurns(history);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: history.map(t => ({ role: t.role, content: t.content })),
          context,
        }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d.error || `Request failed (${res.status})`); setBusy(false); return; }
      const tickets: TicketSummary[] = d.tickets || [];
      if (tickets.length) onTickets(tickets);
      setTurns(h => [...h, {
        role: "assistant",
        content: d.answer || "(no answer)",
        steps: d.steps || [],
        proposals: d.proposals || [],
        ticketCount: tickets.length,
      }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    } finally {
      setBusy(false);
    }
  }

  async function approve(turnIdx: number, propIdx: number, p: Proposal) {
    const key = `${turnIdx}:${propIdx}`;
    setPropStatus(s => ({ ...s, [key]: "approving" }));
    try {
      const res = await fetch(p.endpoint, {
        method: p.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(p.body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPropStatus(s => ({ ...s, [key]: "error" }));
        setPropResult(r => ({ ...r, [key]: d.error || `Failed (${res.status})` }));
        return;
      }
      setPropStatus(s => ({ ...s, [key]: "done" }));
      setPropResult(r => ({ ...r, [key]:
        p.kind === "file_ticket" && d.id ? `Filed #${d.id}` :
        d.commentId ? `Posted${d.newStatus ? ` · status → ${d.newStatus}` : ""}` : "Done" }));
    } catch (e) {
      setPropStatus(s => ({ ...s, [key]: "error" }));
      setPropResult(r => ({ ...r, [key]: e instanceof Error ? e.message : "network error" }));
    }
  }

  const propIcon = (k: Proposal["kind"]) =>
    k === "file_ticket" ? <GitPullRequestArrow className="w-3.5 h-3.5" /> : <FileText className="w-3.5 h-3.5" />;

  return (
    <div style={{ width }} className="fixed top-0 right-0 h-full max-w-full z-40 bg-bg-panel/97 backdrop-blur-sm border-l border-bg-border shadow-2xl flex flex-col animate-fade-in">
      {/* Drag handle — resize the panel by its left edge. */}
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        className="absolute left-0 top-0 h-full w-1.5 -ml-0.5 cursor-col-resize hover:bg-accent/40 active:bg-accent/60 z-50 transition-colors"
      />
      <div className="flex items-center justify-between px-4 py-3 border-b border-bg-border">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent to-fuchsia-600 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-white" strokeWidth={2.5} />
          </div>
          <div className="text-sm font-semibold text-slate-100">Ask Zilla</div>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300" title="Close"><X className="w-4 h-4" /></button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {turns.length === 0 && (
          <div className="text-xs text-slate-500 space-y-2">
            <p>Ask in plain English — I search Bugzilla, read the 3GPP specs, and can draft comments / file tickets for your approval.</p>
            <ul className="space-y-1 text-slate-400">
              <li>· "open blockers older than 90 days with no update in 5 days"</li>
              <li>· "my critical tickets that changed this week"</li>
              <li>· "what does 38.331 say about BWP switching?"</li>
              <li>· "draft a comment on #16523 asking for logs"</li>
            </ul>
          </div>
        )}

        {turns.map((t, i) => (
          <div key={i} className={t.role === "user" ? "text-right" : ""}>
            {t.role === "user" ? (
              <div className="inline-block max-w-[85%] text-left bg-accent/15 ring-1 ring-accent/30 rounded-lg px-3 py-2 text-sm text-slate-100">{t.content}</div>
            ) : (
              <div className="space-y-2">
                {!!t.steps?.length && (
                  <div className="flex flex-wrap gap-1">
                    {t.steps.map((s, k) => (
                      <span key={k} className={`text-[10px] px-1.5 py-0.5 rounded ring-1 inline-flex items-center gap-1 ${s.ok ? "ring-bg-border/60 text-slate-400" : "ring-red-500/40 text-red-400"}`}>
                        <Search className="w-2.5 h-2.5" />{s.note}
                      </span>
                    ))}
                  </div>
                )}
                {!!t.ticketCount && (
                  <div className="text-[11px] text-emerald-400">▤ {t.ticketCount} result{t.ticketCount === 1 ? "" : "s"} shown in the dashboard table</div>
                )}
                <div className="text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">{t.content}</div>
                {t.proposals?.map((p, k) => {
                  const key = `${i}:${k}`;
                  const st = propStatus[key] || "pending";
                  return (
                    <div key={k} className="card p-3 space-y-2 ring-1 ring-amber-500/30">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-amber-300">{propIcon(p.kind)}{p.title}</div>
                      <div className="text-xs text-slate-300 whitespace-pre-wrap max-h-40 overflow-y-auto bg-bg-hover/40 rounded p-2">{p.detail}</div>
                      {st === "done" ? (
                        <div className="text-xs text-emerald-400 flex items-center gap-1"><Check className="w-3.5 h-3.5" />{propResult[key]}</div>
                      ) : st === "error" ? (
                        <div className="text-xs text-red-400">✗ {propResult[key]} <button className="underline" onClick={() => approve(i, k, p)}>retry</button></div>
                      ) : st === "dismissed" ? (
                        <div className="text-xs text-slate-500">Dismissed.</div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button disabled={st === "approving"} onClick={() => approve(i, k, p)} className="btn-primary text-xs disabled:opacity-50">
                            {st === "approving" ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Approve
                          </button>
                          <button disabled={st === "approving"} onClick={() => setPropStatus(s => ({ ...s, [key]: "dismissed" }))} className="btn-ghost text-xs">Dismiss</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}

        {busy && <div className="text-xs text-slate-500 flex items-center gap-2"><LoaderCircle className="w-3.5 h-3.5 animate-spin" /> thinking…</div>}
        {error && <div className="text-xs text-red-400 bg-red-500/10 ring-1 ring-red-500/30 rounded px-3 py-2">{error}</div>}
      </div>

      <div className="border-t border-bg-border p-3">
        <div className="relative">
          <textarea
            className="input w-full pr-10 min-h-[44px] max-h-32 resize-none text-sm"
            placeholder="Ask anything, or describe the tickets you want…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); send(); } }}
          />
          <button onClick={send} disabled={busy || !input.trim()} className="absolute right-2 top-2 text-accent-glow disabled:opacity-40" title="Send (Enter)">
            <Send className="w-4 h-4" />
          </button>
        </div>
        <div className="text-[10px] text-slate-600 mt-1">Reads run automatically · writes need your approval</div>
      </div>
    </div>
  );
}
