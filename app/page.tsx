"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Database } from "lucide-react";
import type { TicketSummary } from "@/lib/types";
import { Logo } from "@/components/ui/Logo";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { TicketFilters, type FilterState } from "@/components/dashboard/TicketFilters";
import { TicketTable } from "@/components/dashboard/TicketTable";

export default function Dashboard() {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<string>("loading");
  const [filters, setFilters] = useState<FilterState>({ q: "", severity: "", status: "", component: "" });

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/tickets");
      const data = await res.json();
      setTickets(data.tickets || []);
      setSource(data.source || "unknown");
      if (data.error) setError(data.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tickets");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    return tickets.filter(t => {
      if (filters.severity && t.severity !== filters.severity) return false;
      if (filters.status && t.status !== filters.status) return false;
      if (filters.component && t.component !== filters.component) return false;
      if (filters.q) {
        const q = filters.q.toLowerCase();
        if (!(t.summary.toLowerCase().includes(q) ||
              String(t.id).includes(q) ||
              t.assignee.toLowerCase().includes(q) ||
              t.component.toLowerCase().includes(q)))
          return false;
      }
      return true;
    });
  }, [tickets, filters]);

  const components = useMemo(
    () => Array.from(new Set(tickets.map(t => t.component))).sort(),
    [tickets]
  );

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-bg-border bg-bg-panel/60 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-[1600px] mx-auto px-6 h-14 flex items-center justify-between">
          <Logo />
          <div className="flex items-center gap-3">
            <SourceIndicator source={source} />
            <button onClick={load} disabled={loading} className="btn-secondary text-xs py-1.5 px-3">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-6 py-6 space-y-5">
        {/* Title row */}
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-xl font-semibold text-slate-100">Triage Queue</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              AI-assisted bug triage with human approval. All Bugzilla writes are gated by your review.
            </p>
          </div>
          <div className="text-xs text-slate-500">
            Showing <span className="text-slate-300 font-medium">{filtered.length}</span> of {tickets.length} tickets
          </div>
        </div>

        {error && (
          <div className="card border-red-500/30 bg-red-950/20 p-3 text-sm text-red-300 animate-fade-in">
            Backend warning: {error} — falling back to mock data so the demo stays usable.
          </div>
        )}

        <StatsBar tickets={tickets} />

        <TicketFilters state={filters} onChange={setFilters} componentOptions={components} />

        <TicketTable tickets={filtered} loading={loading} />

        <div className="text-center text-[11px] text-slate-600 pt-4 pb-8">
          Workflow:&nbsp;
          <span className="text-slate-400">Dashboard</span> →
          <span className="text-slate-400"> Select Ticket</span> →
          <span className="text-accent-glow"> Run AI Triage</span> →
          <span className="text-slate-400"> Review &amp; Edit</span> →
          <span className="text-slate-400"> Approve</span> →
          <span className="text-emerald-400"> Submit to Bugzilla via MCP</span>
        </div>
      </main>
    </div>
  );
}

function SourceIndicator({ source }: { source: string }) {
  const isMock = source.includes("mock");
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <Database className="w-3.5 h-3.5 text-slate-500" />
      <span className="text-slate-500">data:</span>
      <span className={isMock ? "text-amber-400" : "text-emerald-400"}>
        {source === "bugzilla" ? "live Bugzilla" : source === "mock" ? "mock (demo)" : source === "mock-fallback" ? "mock (live backend unavailable)" : source}
      </span>
    </div>
  );
}
