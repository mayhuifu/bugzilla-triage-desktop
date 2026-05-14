"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Database, X, Plus, Loader2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import type {
  TicketSummary, ProductInfo, WhoAmI, DashboardStats, TicketBucket,
} from "@/lib/types";
import { BUCKET_LABELS } from "@/lib/types";
import { Logo } from "@/components/ui/Logo";
import { ProductStatus, TrendBar } from "@/components/dashboard/ProductStatus";
import { TicketFilters, type FilterState } from "@/components/dashboard/TicketFilters";
import { TicketTable } from "@/components/dashboard/TicketTable";
import { SavedFilters } from "@/components/dashboard/SavedFilters";

const DEFAULT_PRODUCT = "U300";
const PAGE_SIZE = 25;          // initial number of tickets shown
const PAGE_INCREMENT = 25;     // each "Load more" click

const INITIAL_FILTERS: FilterState = {
  q: "", product: "", component: "", severity: "", status: "", myTickets: false,
};

export default function Dashboard() {
  const router = useRouter();

  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [products, setProducts] = useState<ProductInfo[]>([]);
  const [whoami, setWhoami] = useState<WhoAmI | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);

  const [loadingTickets, setLoadingTickets] = useState(true);
  const [loadingStats, setLoadingStats] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<string>("loading");

  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);

  // Bulk-triage selection — kept as a Set for O(1) membership checks while
  // rendering the table. Cleared when the user navigates to /bulk-triage.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  // Clicking a card in ProductStatus sets a bucket which overrides the
  // severity/status dropdowns server-side. Null = card filter inactive.
  const [bucket, setBucket] = useState<TicketBucket | null>(null);
  // Page size for the ticket table. Bumps by PAGE_INCREMENT on "Load more".
  const [ticketLimit, setTicketLimit] = useState<number>(PAGE_SIZE);

  // ── Server-side scope query ─────────────────────────────────────────
  // Product/component/my-tickets always go to the server (they change the
  // population we count over). Bucket also goes server-side and overrides
  // the severity/status dropdowns. The dropdowns are passed only when no
  // bucket is active. Freetext stays client-side narrowing.
  const serverQuery = useMemo(() => {
    const qs = new URLSearchParams();
    if (filters.product) qs.set("product", filters.product);
    if (filters.component) qs.set("component", filters.component);
    if (filters.myTickets && whoami?.login) qs.set("assignee", whoami.login);
    if (bucket) {
      qs.set("bucket", bucket);
    } else {
      if (filters.severity) qs.set("severity", filters.severity);
      if (filters.status) qs.set("status", filters.status);
    }
    return qs.toString();
  }, [
    filters.product, filters.component, filters.myTickets, whoami?.login,
    bucket, filters.severity, filters.status,
  ]);

  // Limit is part of the same useEffect trigger but kept separate so we can
  // distinguish "scope changed → reset to PAGE_SIZE" from "Load more".
  const ticketQuery = useMemo(() => {
    const qs = new URLSearchParams(serverQuery);
    qs.set("limit", String(ticketLimit));
    return qs.toString();
  }, [serverQuery, ticketLimit]);

  // ── Bootstrap: products + whoami in parallel (one-shot per session) ──
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/products").then(r => r.json()).catch(() => ({ products: [] })),
      fetch("/api/whoami").then(r => r.json()).catch(() => null),
    ]).then(([p, w]) => {
      if (cancelled) return;
      const list: ProductInfo[] = p.products || [];
      setProducts(list);
      if (list.some(prod => prod.name === DEFAULT_PRODUCT)) {
        setFilters(f => f.product ? f : { ...f, product: DEFAULT_PRODUCT });
      }
      if (w?.login) setWhoami(w);
    });
    return () => { cancelled = true; };
  }, []);

  // ── Load tickets when ticketQuery changes ────────────────────────────
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

  // When the scope (excluding limit) changes, reset pagination to page 1.
  // The two effects below split tickets from stats: stats don't paginate.
  useEffect(() => {
    if (filters.myTickets && !whoami?.login) return;
    setTicketLimit(PAGE_SIZE);
    loadStats(serverQuery);
  }, [serverQuery, filters.myTickets, whoami?.login, loadStats]);

  useEffect(() => {
    if (filters.myTickets && !whoami?.login) return;
    loadTickets(ticketQuery);
  }, [ticketQuery, filters.myTickets, whoami?.login, loadTickets]);

  // ── Client-side narrowing: freetext only (severity/status now server-side)
  const filtered = useMemo(() => {
    if (!filters.q) return tickets;
    const q = filters.q.toLowerCase();
    return tickets.filter(t =>
      t.summary.toLowerCase().includes(q) ||
      String(t.id).includes(q) ||
      t.assignee.toLowerCase().includes(q) ||
      t.component.toLowerCase().includes(q),
    );
  }, [tickets, filters.q]);

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
    loadTickets(ticketQuery);
    loadStats(serverQuery);
  }, [ticketQuery, serverQuery, loadTickets, loadStats]);

  // Bucket selection from ProductStatus cards. Clears the severity/status
  // dropdowns so they don't visually conflict with the active bucket.
  const handleSelectBucket = useCallback((b: TicketBucket | null) => {
    setBucket(b);
    if (b) setFilters(f => ({ ...f, severity: "", status: "" }));
  }, []);

  // Picking a severity/status from the dropdown clears any active bucket.
  const handleFiltersChange = useCallback((next: FilterState) => {
    setFilters(prev => {
      const dropdownChanged = next.severity !== prev.severity || next.status !== prev.status;
      if (dropdownChanged && bucket) setBucket(null);
      return next;
    });
  }, [bucket]);

  // Heuristic: if the server returned exactly `ticketLimit` tickets, there
  // may be more — show Load more. (Bugzilla's /rest/bug doesn't return a
  // total count.) Filtered count is what the user sees post-freetext.
  const hasMore = tickets.length >= ticketLimit;
  const onLoadMore = () => setTicketLimit(l => l + PAGE_INCREMENT);

  // ── Bulk selection helpers ───────────────────────────────────────────
  const onToggleSelect = useCallback((id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const onToggleAll = useCallback((allSelected: boolean) => {
    setSelectedIds(prev => {
      // Toggle across the currently visible (filtered) rows only.
      const next = new Set(prev);
      if (allSelected) {
        for (const t of filtered) next.delete(t.id);
      } else {
        for (const t of filtered) next.add(t.id);
      }
      return next;
    });
  }, [filtered]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const onBulkTriage = useCallback(() => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds).join(",");
    router.push(`/bulk-triage?ids=${ids}`);
  }, [selectedIds, router]);

  // When the underlying ticket list changes (filter change, refresh),
  // prune selected ids that are no longer visible to avoid stale state.
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const visible = new Set(tickets.map(t => t.id));
    let changed = false;
    const next = new Set<number>();
    for (const id of selectedIds) {
      if (visible.has(id)) next.add(id); else changed = true;
    }
    if (changed) setSelectedIds(next);
    // Intentionally only react to `tickets` — selectedIds itself shouldn't
    // re-trigger the pruning pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets]);

  // ── Saved-filters apply: restore filters + bucket + reset pagination ─
  const onApplySaved = useCallback((f: FilterState, b: TicketBucket | null) => {
    setFilters(f);
    setBucket(b);
    setTicketLimit(PAGE_SIZE);
  }, []);

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
            Showing <span className="text-slate-300 font-medium">{filtered.length}</span>
            {filters.q && filtered.length !== tickets.length && (
              <span> of <span className="text-slate-300">{tickets.length}</span> loaded</span>
            )}
            {!filters.q && hasMore && <span className="text-slate-500"> (more available)</span>}
          </div>
        </div>

        {error && (
          <div className="card border-red-500/30 bg-red-950/20 p-3 text-sm text-red-300 animate-fade-in">
            Backend warning: {error} — falling back to mock data so the demo stays usable.
          </div>
        )}

        <ProductStatus
          stats={stats}
          loading={loadingStats}
          scopeLabel={scopeLabel}
          activeBucket={bucket}
          onSelectBucket={handleSelectBucket}
        />

        <TrendBar
          stats={stats}
          loading={loadingStats}
          activeBucket={bucket}
          onSelectBucket={handleSelectBucket}
        />

        <div className="flex flex-wrap items-stretch gap-2">
          <div className="flex-1 min-w-[280px]">
            <TicketFilters
              state={filters}
              onChange={handleFiltersChange}
              products={products}
              componentOptions={componentsFromLoaded}
              whoami={whoami}
              bucketActive={bucket !== null}
            />
          </div>
          <SavedFilters
            currentFilters={filters}
            currentBucket={bucket}
            onApply={onApplySaved}
          />
        </div>

        {bucket && (
          <div className="flex items-center gap-2 text-xs animate-fade-in">
            <span className="text-slate-500">Filtered by:</span>
            <button
              onClick={() => handleSelectBucket(null)}
              className="badge bg-accent/15 text-accent-glow ring-1 ring-accent/40 hover:bg-accent/25 flex items-center gap-1.5"
            >
              {BUCKET_LABELS[bucket]}
              <X className="w-3 h-3" />
            </button>
            <span className="text-slate-600">click again or × to clear</span>
          </div>
        )}

        <TicketTable
          tickets={filtered}
          loading={loadingTickets}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          onToggleAll={onToggleAll}
        />

        {selectedIds.size > 0 && (
          <BulkActionBar
            count={selectedIds.size}
            onTriage={onBulkTriage}
            onClear={clearSelection}
          />
        )}

        {/* Load-more / page-size affordance. Shown when the last fetch
            saturated the limit. Hidden if a freetext filter is narrowing
            results client-side (extra results would only appear under the
            current free-text query, which is confusing). */}
        {hasMore && !filters.q && (
          <div className="flex flex-col items-center gap-1.5 py-2">
            <button
              onClick={onLoadMore}
              disabled={loadingTickets}
              className="btn-secondary text-xs"
            >
              {loadingTickets
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Plus className="w-3.5 h-3.5" />}
              Load {PAGE_INCREMENT} more (showing {tickets.length})
            </button>
            <div className="text-[10px] text-slate-600">
              Sorted newest-first · click a status card above to filter
            </div>
          </div>
        )}

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

// Sticky-bottom bar shown when ≥1 ticket is selected. The dashboard hands
// off to /bulk-triage which runs the per-ticket AI calls with a concurrency
// cap; we keep the dashboard view "select-and-launch" only.
function BulkActionBar({
  count, onTriage, onClear,
}: {
  count: number; onTriage: () => void; onClear: () => void;
}) {
  return (
    <div className="sticky bottom-4 z-30 flex justify-center pointer-events-none">
      <div className="pointer-events-auto card px-4 py-2.5 flex items-center gap-3 shadow-2xl ring-2 ring-accent/40 bg-bg-panel/95 backdrop-blur-sm animate-fade-in">
        <div className="text-sm">
          <span className="text-slate-100 font-medium">{count}</span>
          <span className="text-slate-400"> ticket{count === 1 ? "" : "s"} selected</span>
        </div>
        <button onClick={onTriage} className="btn-primary text-xs">
          <Sparkles className="w-3.5 h-3.5" />
          Bulk AI triage
        </button>
        <button onClick={onClear} className="btn-ghost text-xs" title="Clear selection">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
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
