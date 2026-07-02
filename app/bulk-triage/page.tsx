"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Sparkles, Loader2, CheckCircle2, AlertCircle, Play, ExternalLink, ArrowLeft, Pause,
} from "lucide-react";
import { Logo } from "@/components/ui/Logo";
import { ConfidenceBadge } from "@/components/ui/Badge";
import type { TicketDetail, TriageResult } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────
// Bulk triage page
//
// Reads ?ids=1,2,3 from the URL. For each id, fetches the ticket detail
// then runs AI triage. Triage calls are heavy (30–90s each + claude CLI
// concurrency), so we cap parallelism at BULK_CONCURRENCY — running more
// than ~3 in parallel risks rate limits on the user's Claude Code
// subscription and resource exhaustion on the local machine.
//
// Each row tracks its own state (pending → fetching → triaging → done |
// error) so the user sees per-ticket progress. Clicking a finished row
// jumps to the full detail page to review and submit.
// ─────────────────────────────────────────────────────────────────

const BULK_CONCURRENCY = 3;

type RowState =
  | { kind: "pending" }
  | { kind: "fetching" }
  | { kind: "triaging"; ticket: TicketDetail }
  | { kind: "done"; ticket: TicketDetail; triage: TriageResult }
  | { kind: "error"; message: string };

interface Row {
  id: number;
  state: RowState;
}

// Next.js 15 prerender requires components that use useSearchParams to sit
// inside a Suspense boundary so the page can statically opt out cleanly.
export default function BulkTriagePage() {
  return (
    <Suspense fallback={<BulkTriageLoading />}>
      <BulkTriageInner />
    </Suspense>
  );
}

function BulkTriageLoading() {
  return (
    <main className="max-w-2xl mx-auto px-6 py-12 text-center">
      <Loader2 className="w-6 h-6 animate-spin text-accent mx-auto" />
      <div className="text-sm text-slate-400 mt-3">Preparing bulk triage…</div>
    </main>
  );
}

function BulkTriageInner() {
  const sp = useSearchParams();
  const ids = useMemo(() => parseIds(sp.get("ids") || ""), [sp]);

  const [rows, setRows] = useState<Row[]>(() => ids.map(id => ({ id, state: { kind: "pending" } })));
  const [running, setRunning] = useState(false);
  // A monotonic "run id" lets a fresh Start cancel any old in-flight
  // workers by ignoring their results — simpler than threading
  // AbortController through every fetch.
  const [runId, setRunId] = useState(0);
  // Ref shadows runId so the async worker can read the latest value
  // without being re-bound on every state change.
  const runIdRef = useRef(0);
  runIdRef.current = runId;

  // Keep rows in sync with the URL on initial load only — we don't want
  // the URL changing after Start to wipe progress.
  useEffect(() => {
    setRows(ids.map(id => ({ id, state: { kind: "pending" } })));
  }, [ids]);

  const updateRow = useCallback((id: number, state: RowState) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, state } : r));
  }, []);

  const processOne = useCallback(async (id: number, currentRunId: number) => {
    const checkRun = () => currentRunId === runIdRef.current;
    updateRow(id, { kind: "fetching" });
    let ticket: TicketDetail;
    try {
      const r = await fetch(`/api/tickets/${id}`);
      const data = await r.json();
      if (!data.ticket) throw new Error(data.error || "ticket not found");
      ticket = data.ticket;
    } catch (err) {
      if (checkRun()) updateRow(id, { kind: "error", message: (err as Error).message });
      return;
    }
    if (!checkRun()) return;
    updateRow(id, { kind: "triaging", ticket });
    try {
      const r = await fetch(`/api/tickets/${id}/triage`, { method: "POST" });
      const data = await r.json();
      if (!checkRun()) return;
      if (data.triage) {
        updateRow(id, { kind: "done", ticket, triage: data.triage });
      } else {
        updateRow(id, { kind: "error", message: data.error || "triage returned no result" });
      }
    } catch (err) {
      if (checkRun()) updateRow(id, { kind: "error", message: (err as Error).message });
    }
  }, [updateRow]);

  const onStartAll = useCallback(async () => {
    const nextRunId = runId + 1;
    setRunId(nextRunId);
    runIdRef.current = nextRunId;
    setRunning(true);
    // Reset only rows that are pending or errored — keep done rows so a
    // second Start doesn't reprocess work the user already saw succeed.
    setRows(prev => prev.map(r =>
      r.state.kind === "done" ? r : { ...r, state: { kind: "pending" } }
    ));
    // Fixed-size worker pool — N workers pull from a shared queue.
    const queue = rows.filter(r => r.state.kind !== "done").map(r => r.id);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(BULK_CONCURRENCY, queue.length) }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= queue.length) return;
        if (nextRunId !== runIdRef.current) return;
        await processOne(queue[idx], nextRunId);
      }
    });
    await Promise.all(workers);
    if (nextRunId === runIdRef.current) setRunning(false);
  }, [rows, runId, processOne]);

  const onStop = useCallback(() => {
    setRunId(r => r + 1);   // invalidates in-flight workers
    setRunning(false);
  }, []);

  const counts = useMemo(() => {
    const c = { pending: 0, working: 0, done: 0, error: 0 };
    for (const r of rows) {
      if (r.state.kind === "pending") c.pending++;
      else if (r.state.kind === "done") c.done++;
      else if (r.state.kind === "error") c.error++;
      else c.working++;
    }
    return c;
  }, [rows]);

  if (!ids.length) {
    return (
      <main className="max-w-2xl mx-auto px-6 py-12">
        <div className="card p-8 text-center space-y-3">
          <AlertCircle className="w-8 h-8 text-amber-400 mx-auto" />
          <div className="text-base text-slate-200 font-medium">No tickets selected</div>
          <div className="text-sm text-slate-500">
            Open this page from the dashboard with one or more tickets selected.
          </div>
          <Link href="/" className="btn-secondary mt-2 inline-flex">
            <ArrowLeft className="w-3.5 h-3.5" /> Back to dashboard
          </Link>
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-bg-border bg-bg-panel/60 backdrop-blur-sm sticky top-0 z-20">
        <div className="w-full px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/"><Logo /></Link>
            <div className="text-xs text-slate-500">
              <span className="text-slate-400">Triage Workflow</span>
              <span className="mx-2 text-slate-700">·</span>
              <span>Bulk Triage</span>
              <span className="mx-2 text-slate-700">·</span>
              <span>{ids.length} ticket{ids.length === 1 ? "" : "s"}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {running ? (
              <button onClick={onStop} className="btn-secondary text-xs">
                <Pause className="w-3.5 h-3.5" /> Stop
              </button>
            ) : (
              <button
                onClick={onStartAll}
                disabled={counts.pending === 0 && counts.error === 0}
                className="btn-primary text-xs"
              >
                <Play className="w-3.5 h-3.5" />
                {counts.done > 0 ? "Re-run pending / errored" : "Start AI triage"}
              </button>
            )}
            <Link href="/" className="btn-ghost text-xs">
              <ArrowLeft className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </header>

      <main className="w-full px-4 sm:px-6 lg:px-8 py-6 space-y-4">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-xl font-semibold text-slate-100">Bulk AI Triage</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Up to {BULK_CONCURRENCY} tickets run in parallel via your configured LLM provider.
              Click any completed row to review and submit it individually.
            </p>
          </div>
          <ProgressSummary counts={counts} total={rows.length} />
        </div>

        <div className="space-y-2">
          {rows.map(r => <BulkRow key={r.id} row={r} />)}
        </div>
      </main>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseIds(raw: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const part of raw.split(",")) {
    const n = parseInt(part.trim(), 10);
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

function ProgressSummary({
  counts, total,
}: {
  counts: { pending: number; working: number; done: number; error: number };
  total: number;
}) {
  const pct = total === 0 ? 0 : Math.round((counts.done / total) * 100);
  return (
    <div className="text-right">
      <div className="text-xs text-slate-500">
        <span className="text-emerald-300 font-medium">{counts.done}</span> done
        {counts.working > 0 && <> · <span className="text-accent">{counts.working}</span> running</>}
        {counts.pending > 0 && <> · <span className="text-slate-400">{counts.pending}</span> pending</>}
        {counts.error > 0 && <> · <span className="text-red-400">{counts.error}</span> error</>}
        {" · "}{pct}%
      </div>
    </div>
  );
}

function BulkRow({ row }: { row: Row }) {
  const id = row.id;
  switch (row.state.kind) {
    case "pending":
      return (
        <div className="card p-4 flex items-center gap-3">
          <StateDot tone="slate" />
          <div className="text-sm text-slate-400 font-mono">#{id}</div>
          <div className="flex-1 text-xs text-slate-500">Pending — click Start to begin.</div>
        </div>
      );
    case "fetching":
      return (
        <div className="card p-4 flex items-center gap-3">
          <Loader2 className="w-4 h-4 animate-spin text-accent" />
          <div className="text-sm text-slate-400 font-mono">#{id}</div>
          <div className="flex-1 text-xs text-slate-400">Fetching ticket from Bugzilla…</div>
        </div>
      );
    case "triaging": {
      const t = row.state.ticket;
      return (
        <div className="card p-4">
          <div className="flex items-center gap-3 mb-1">
            <Loader2 className="w-4 h-4 animate-spin text-fuchsia-400" />
            <div className="text-sm text-slate-400 font-mono">#{id}</div>
            <div className="flex-1 text-slate-200 truncate">{t.summary}</div>
          </div>
          <div className="text-xs text-slate-500 pl-7">
            Running AI triage · {t.product} / {t.component} · severity {t.severity}
          </div>
        </div>
      );
    }
    case "done": {
      const t = row.state.ticket;
      const tr = row.state.triage;
      return (
        <div className="card p-4 ring-1 ring-emerald-500/20">
          <div className="flex items-center gap-3 mb-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <div className="text-sm text-slate-400 font-mono">#{id}</div>
            <Link
              href={`/tickets/${id}`}
              target="_blank"
              className="flex-1 text-slate-100 hover:text-accent-glow font-medium truncate"
            >
              {t.summary}
            </Link>
            <ConfidenceBadge confidence={tr.confidence} />
            <Link
              href={`/tickets/${id}`}
              target="_blank"
              className="btn-primary text-xs"
              title="Open this ticket for review and submit"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Review & submit
            </Link>
          </div>
          <div className="text-xs text-slate-400 pl-7">
            <span className="text-slate-500">Domain:</span> <span className="font-mono">{tr.domain}</span>
          </div>
          <div className="text-xs text-slate-300 pl-7 mt-1">{tr.issueSummary}</div>
          {tr.rootCauses[0] && (
            <div className="text-[11px] text-slate-500 pl-7 mt-1.5">
              Top hypothesis ({tr.rootCauses[0].likelihood}): {tr.rootCauses[0].label}
            </div>
          )}
        </div>
      );
    }
    case "error":
      return (
        <div className="card p-4 ring-1 ring-red-500/30 flex items-center gap-3">
          <AlertCircle className="w-4 h-4 text-red-400" />
          <div className="text-sm text-slate-400 font-mono">#{id}</div>
          <div className="flex-1 text-xs text-red-300 break-words">{row.state.message}</div>
          <Link href={`/tickets/${id}`} target="_blank" className="btn-ghost text-xs">
            Open <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
      );
  }
}

function StateDot({ tone }: { tone: "slate" | "accent" | "emerald" | "red" }) {
  const cls = {
    slate: "bg-slate-700",
    accent: "bg-accent",
    emerald: "bg-emerald-400",
    red: "bg-red-400",
  }[tone];
  return <div className={`w-2.5 h-2.5 rounded-full ${cls}`} />;
}
