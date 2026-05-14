"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Database } from "lucide-react";
import type { TicketSummary, ProductInfo, WhoAmI, DashboardStats } from "@/lib/types";
import { Logo } from "@/components/ui/Logo";
import { ProductStatus, TrendBar } from "@/components/dashboard/ProductStatus";
import { TicketFilters, type FilterState } from "@/components/dashboard/TicketFilters";
import { TicketTable } from "@/components/dashboard/TicketTable";

const INITIAL_FILTERS: FilterState = {
  q: "", product: "", component: "", severity: "", status: "", myTickets: false,
};

export default function Dashboard() {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [products, setProducts] = useState<ProductInfo[]>([]);
  const [whoami, setWhoami] = useState<WhoAmI | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);

  const [loadingTickets, setLoadingTickets] = useState(true);
  const [loadingStats, setLoadingStats] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<string>("loading");

  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);

  // Product/component/my-tickets are server-side filters — they change the
  // population we count over, so they go into the query string. Severity /
  // status / freetext stay client-side (they narrow the visible table).
  const serverQuery = useMemo(() => {
    const qs = new URLSearchParams();
    if (filters.product) qs.set("product", filters.product);
    if (filters.component) qs.set("component", filters.component);
    if (filters.myTickets && whoami?.login) qs.set("assignee", whoami.login);
    return qs.toString();
  }, [filters.product, filters.component, filters.myTickets, whoami?.login]);

  // ── Bootstrap: products + whoami in parallel (one-shot per session) ──
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/products").then(r => r.json()).catch(() => ({ products: [] })),
      fetch("/api/whoami").then(r => r.json()).catch(() => null),
    ]).then(([p, w]) => {
      if (cancelled) return;
      setProducts(p.products || []);
      if (w?.login) setWhoami(w);
    });
    return () => { cancelled = true; };
  }, []);

  // ── Tickets + stats refetch whenever the server-side scope changes ───
  const loadTickets = useCallback(async (qs: string) => {
    setLoadingTickets(true);
    setError(null);
    try {
      const res = await fetch(`/api/tickets${qs ? `?${qs}` : ""}`);
      const data = await res.json();
      setTickets(data.tickets || []);
      setSource(data.source || "unknown");
      if (data.error) setError(data.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tickets");
    } finally {
      setLoadingTickets(false);
    }
  }, []);

  const loadStats = useCallback(async (qs: string) => {
    setLoadingStats(true);
    try {
      const res = await fetch(`/api/stats${qs ? `?${qs}` : ""}`);
      const data: DashboardStats = await res.json();
      setStats(data);
    } catch {
      setStats(null);
    } finally {
      setLoadingStats(false);
    }
  }, []);

  useEffect(() => {
    // Don't fire My-Tickets-scoped queries until whoami has resolved.
    if (filters.myTickets && !whoami?.login) return;
    loadTickets(serverQuery);
    loadStats(serverQuery);
  }, [serverQuery, filters.myTickets, whoami?.login, loadTickets, loadStats]);

  // ── Client-side narrowing on the table only (severity/status/q) ──────
  const filtered = useMemo(() => {
    return tickets.filter(t => {
      if (filters.severity && t.severity !== filters.severity) return false;
      if (filters.status && t.status !== filters.status) return false;
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
  }, [tickets, filters.severity, filters.status, filters.q]);

  // Fallback component list for the dropdown when no product is picked yet.
  const componentsFromLoaded = useMemo(
    () => Array.from(new Set(tickets.map(t => t.component))).sort(),
    [tickets],
  );

  const scopeLabel = useMemo(() => {
    const parts: string[] = [];
    if (filters.product) parts.push(filters.product);
    if (filters.component) parts.push(filters.component);
    if (filters.myTickets && whoami?.login) parts.push(`@${whoami.login.split("@")[0]}`);
    return parts.length ? parts.join(" · ") : "all products";
  }, [filters.product, filters.component, filters.myTickets, whoami?.login]);

  const refreshAll = useCallback(() => {
    loadTickets(serverQuery);
    loadStats(serverQuery);
  }, [serverQuery, loadTickets, loadStats]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-bg-border bg-bg-panel/60 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-[1600px] mx-auto px-6 h-14 flex items-center justify-between">
          <Logo />
          <div className="flex items-center gap-3">
            {whoami?.login && (
              <span className="text-[11px] text-slate-500">
                signed in as <span className="text-slate-300">{whoami.login}</span>
              </span>
            )}
            <SourceIndicator source={source} />
            <button onClick={refreshAll} disabled={loadingTickets || loadingStats}
                    className="btn-secondary text-xs py-1.5 px-3">
              <RefreshCw className={`w-3.5 h-3.5 ${(loadingTickets || loadingStats) ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-6 py-6 space-y-5">
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

        <ProductStatus stats={stats} loading={loadingStats} scopeLabel={scopeLabel} />

        <TrendBar stats={stats} loading={loadingStats} />

        <TicketFilters
          state={filters}
          onChange={setFilters}
          products={products}
          componentOptions={componentsFromLoaded}
          whoami={whoami}
        />

        <TicketTable tickets={filtered} loading={loadingTickets} />

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
        {source === "bugzilla-mcp" ? "live Bugzilla" :
         source === "mock" ? "mock (demo)" :
         source === "mock-fallback" ? "mock (live backend unavailable)" : source}
      </span>
    </div>
  );
}
