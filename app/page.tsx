"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Database, X, Plus, Loader2, Sparkles, Settings as SettingsIcon, AlertCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type {
  TicketSummary, ProductInfo, WhoAmI, DashboardStats, TicketBucket,
} from "@/lib/types";
import { BUCKET_LABELS } from "@/lib/types";
import { Logo } from "@/components/ui/Logo";
import { HeaderNav } from "@/components/ui/HeaderNav";
import { CorpusInstallBanner } from "@/components/corpus/CorpusInstallBanner";
import { ProductStatus, TrendBar } from "@/components/dashboard/ProductStatus";
import { TicketFilters, type FilterState } from "@/components/dashboard/TicketFilters";
import { TicketTable } from "@/components/dashboard/TicketTable";
import { SavedFilters } from "@/components/dashboard/SavedFilters";
import { FileTicketDialog } from "@/components/dashboard/FileTicketDialog";
import { AskZillaPanel } from "@/components/assistant/AskZillaPanel";
import {
  getCachedStats, setCachedStats, getCachedTickets, setCachedTickets,
} from "@/lib/dashboard-cache";

const DEFAULT_PRODUCT = "U300";
const PAGE_SIZE = 25;          // initial number of tickets shown
const PAGE_INCREMENT = 25;     // each "Load more" click

const INITIAL_FILTERS: FilterState = {
  q: "", product: "", component: "", assignee: "", severity: "", status: "", myTickets: false,
  myRoles: { assignee: true, reporter: false, cc: false },
};

const MY_ROLES_KEY = "zilla-my-roles";
// Active dashboard view (filters + status-card bucket + any Ask Zilla result
// set), persisted for the browser session so navigating into a ticket and back
// restores the exact view the user left — including an Ask Zilla result list —
// instead of snapping to the default product / underlying filter view.
// sessionStorage (not local) so it survives in-app navigation but resets on a
// fresh app launch.
const DASH_VIEW_KEY = "zilla-dashboard-view";

export default function Dashboard() {
  const router = useRouter();
  // Records that a saved view WAS applied on mount, so the bootstrap skips the
  // default-product override (see the restore effect + bootstrap below).
  const hadSavedViewRef = useRef(false);

  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [products, setProducts] = useState<ProductInfo[]>([]);
  const [whoami, setWhoami] = useState<WhoAmI | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);

  const [loadingTickets, setLoadingTickets] = useState(true);
  const [loadingStats, setLoadingStats] = useState(true);  // the 6 open/closed cards
  const [loadingTrend, setLoadingTrend] = useState(true);  // the 8 trend-bar queries
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<string>("loading");

  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);

  // "File a Ticket" modal (button next to My Tickets).
  const [fileTicketOpen, setFileTicketOpen] = useState(false);
  // Ask Zilla agent panel + the ticket list it produces (overrides the table).
  const [askOpen, setAskOpen] = useState(false);
  const [assistantResults, setAssistantResults] = useState<TicketSummary[] | null>(null);
  // Width the Ask Zilla panel currently occupies (0 when closed). The dashboard
  // reserves this much space on the right so the panel sits BESIDE the content
  // instead of overlaying it.
  const [askWidth, setAskWidth] = useState(0);
  // Legal values of the install's mandatory "Type" field (from /api/products).
  const [typeOptions, setTypeOptions] = useState<string[]>([]);

  // Persist the My-Tickets role selection (assignee/reporter/cc) across sessions.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(MY_ROLES_KEY);
      if (!saved) return;
      const p = JSON.parse(saved) as Partial<FilterState["myRoles"]>;
      const roles = { assignee: !!p.assignee, reporter: !!p.reporter, cc: !!p.cc };
      if (!roles.assignee && !roles.reporter && !roles.cc) roles.assignee = true;
      setFilters(f => ({ ...f, myRoles: roles }));
    } catch { /* ignore malformed prefs */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(MY_ROLES_KEY, JSON.stringify(filters.myRoles)); } catch { /* ignore */ }
  }, [filters.myRoles]);

  // Bulk-triage selection — kept as a Set for O(1) membership checks while
  // rendering the table. Cleared when the user navigates to /bulk-triage.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());

  // First-run detection — `null` while we're still checking, `false` if the
  // user hasn't entered Bugzilla credentials yet (show banner + skip fetches),
  // `true` once /api/settings reports the connection is configured.
  const [configured, setConfigured] = useState<boolean | null>(null);
  // Server (multi-user) mode flag from /api/settings — gates the per-user
  // corpus banner (in server mode the corpus is a shared, admin-installed
  // asset, not a per-user download).
  const [multiUser, setMultiUser] = useState(false);
  // Gate for the data-loading effects. Stays false until the bootstrap has
  // settled the default scope (products fetched + DEFAULT_PRODUCT applied).
  // Without this, the effects fire once with the EMPTY "all-products" scope
  // — the slowest possible stats query (counts every product) — and then
  // immediately re-fire for the U300 default, doing (and on a cold cache,
  // waiting on) a big query whose result is instantly discarded. Gating
  // here means stats/tickets load exactly once, for the real scope.
  const [scopeReady, setScopeReady] = useState(false);
  // Clicking a card in ProductStatus sets a bucket which overrides the
  // severity/status dropdowns server-side. Null = card filter inactive.
  const [bucket, setBucket] = useState<TicketBucket | null>(null);
  // Page size for the ticket table. Bumps by PAGE_INCREMENT on "Load more".
  const [ticketLimit, setTicketLimit] = useState<number>(PAGE_SIZE);

  // ── Restore the previous dashboard view on mount (e.g. returning from a
  // ticket) so the user's filters + status-card selection survive the
  // round-trip instead of resetting to the default product. ──
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(DASH_VIEW_KEY);
      if (saved) {
        const v = JSON.parse(saved) as {
          filters?: Partial<FilterState>;
          bucket?: TicketBucket | null;
          assistantResults?: TicketSummary[] | null;
        };
        if (v.filters) {
          setFilters(f => ({ ...f, ...v.filters }));
          hadSavedViewRef.current = true;   // bootstrap then skips DEFAULT_PRODUCT
        }
        if (v.bucket) setBucket(v.bucket);
        // Restore the Ask Zilla result set too — without this, returning from a
        // ticket would drop back to the underlying filter view instead of the
        // Ask Zilla results the user was looking at when they clicked through.
        if (Array.isArray(v.assistantResults) && v.assistantResults.length) {
          setAssistantResults(v.assistantResults);
        }
      }
    } catch { /* ignore a malformed saved view */ }
  }, []);
  // Persist the active view — gated on scopeReady so the mount/restore window
  // (where filters are briefly the start-up defaults, and React Strict Mode
  // double-invokes effects in dev) can never clobber the saved view. By the
  // time scopeReady flips true, restore has applied and bootstrap has settled.
  useEffect(() => {
    if (!scopeReady) return;
    try {
      sessionStorage.setItem(DASH_VIEW_KEY, JSON.stringify({ filters, bucket, assistantResults }));
    } catch { /* ignore quota / disabled storage */ }
  }, [filters, bucket, assistantResults, scopeReady]);

  // ── Debounced freetext query (for server-side Bugzilla quicksearch) ──
  // When the user types a non-numeric search term (assignee, component,
  // word in summary, natural-language phrase) we forward it to Bugzilla
  // as `quicksearch=` after a 300 ms idle so we don't fire a request per
  // keystroke. Numeric queries are excluded — those go through the
  // direct-ticket-ID lookup path below, which fetches `/api/tickets/<id>`
  // and pins one ticket. Pure 1-char terms are also skipped (too noisy
  // on a busy Bugzilla).
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    const q = filters.q.trim();
    if (!q || /^\d+$/.test(q) || q.length < 2) {
      setDebouncedQ("");
      return;
    }
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [filters.q]);

  // ── Server-side scope query ─────────────────────────────────────────
  // Product/component/my-tickets always go to the server (they change the
  // population we count over). Bucket also goes server-side and overrides
  // the severity/status dropdowns. The dropdowns are passed only when no
  // bucket is active. Non-numeric freetext goes server-side as
  // `quicksearch=` so users can find tickets that aren't in the loaded
  // page window (assignees, components, summary terms, natural language).
  const serverQuery = useMemo(() => {
    const qs = new URLSearchParams();
    if (filters.product) qs.set("product", filters.product);
    if (filters.component) qs.set("component", filters.component);
    // "My Tickets" = every ticket the user is involved with (assignee OR
    // reporter OR CC) via the `involves` param — not just assignee. Takes
    // precedence over the explicit assignee dropdown (also disabled in UI), but
    // belt-and-suspenders so a stale value can't sneak through.
    if (filters.myTickets && whoami?.login) {
      qs.set("involves", whoami.login);
      const roles = (["assignee", "reporter", "cc"] as const).filter(r => filters.myRoles[r]);
      qs.set("roles", (roles.length ? roles : ["assignee"]).join(","));
    } else if (filters.assignee) {
      qs.set("assignee", filters.assignee);
    }
    if (bucket) {
      qs.set("bucket", bucket);
    } else {
      if (filters.severity) qs.set("severity", filters.severity);
      if (filters.status) qs.set("status", filters.status);
    }
    if (debouncedQ) qs.set("q", debouncedQ);
    return qs.toString();
  }, [
    filters.product, filters.component, filters.assignee,
    filters.myTickets, filters.myRoles.assignee, filters.myRoles.reporter, filters.myRoles.cc,
    whoami?.login,
    bucket, filters.severity, filters.status, debouncedQ,
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
    // Check settings first; if Bugzilla isn't configured, skip the
    // products/whoami fetches — they'd just 502 against an unset URL.
    fetch("/api/settings").then(r => r.json()).then((s: { configured: boolean; multiUser?: boolean }) => {
      if (cancelled) return;
      setConfigured(s.configured);
      setMultiUser(Boolean(s.multiUser));
      if (!s.configured) return;
      Promise.all([
        fetch("/api/products").then(r => r.json()).catch(() => ({ products: [] })),
        fetch("/api/whoami").then(r => r.json()).catch(() => null),
      ]).then(([p, w]) => {
        if (cancelled) return;
        const list: ProductInfo[] = p.products || [];
        setProducts(list);
        setTypeOptions(p.typeOptions || []);
        // Apply the default product only on a FRESH view — a restored view
        // (returning from a ticket) already carries the user's product, even
        // if that product is "" (an explicit "All products" choice).
        if (!hadSavedViewRef.current && list.some(prod => prod.name === DEFAULT_PRODUCT)) {
          setFilters(f => f.product ? f : { ...f, product: DEFAULT_PRODUCT });
        }
        if (w?.login) setWhoami(w);
        // Scope is now settled (default product applied if available) — let
        // the data effects fire once, for the real scope. Batched with the
        // setFilters above so serverQuery already reflects the default.
        setScopeReady(true);
      });
    }).catch(() => {
      // Settings endpoint should never fail; if it does, assume not configured.
      if (!cancelled) setConfigured(false);
    });
    return () => { cancelled = true; };
  }, []);

  // ── Load tickets when ticketQuery changes ────────────────────────────
  const loadTickets = useCallback(async (qs: string, fresh = false) => {
    // Serve from the client snapshot cache on navigation-back (≤24h) so the
    // list shows instantly without a re-fetch. Refresh (fresh) bypasses it.
    if (!fresh) {
      const cachedT = getCachedTickets(qs);
      if (cachedT) {
        setTickets(cachedT.tickets);
        setSource(cachedT.source);
        setError(null);
        setLoadingTickets(false);
        return;
      }
    }
    setLoadingTickets(true);
    setError(null);
    try {
      const res = await fetch(`/api/tickets${qs ? `?${qs}` : ""}`);
      const data = await res.json();
      setTickets(data.tickets || []);
      setSource(data.source || "unknown");
      if (data.error) setError(data.error);
      // Cache only real Bugzilla results — never pin a mock / mock-fallback
      // page (which would otherwise survive for 24h once Bugzilla recovers).
      if (!data.error && data.source === "bugzilla-mcp") {
        setCachedTickets(qs, { tickets: data.tickets || [], source: data.source });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tickets");
    } finally {
      setLoadingTickets(false);
    }
  }, []);

  const loadStats = useCallback((qs: string, fresh = false) => {
    // Navigation-back fast path: hydrate instantly from the client snapshot
    // cache (≤24h) — no fetch, no skeleton flash. Refresh (fresh) skips it.
    if (!fresh) {
      const cachedS = getCachedStats(qs);
      if (cachedS) {
        setStats(cachedS);
        setLoadingStats(false);
        setLoadingTrend(false);
        return;
      }
    }

    // Split load: the 6 open/closed card counts ("core") and the 8
    // week-over-week trend counts ("trend") are fetched as two independent
    // requests so the cards paint as soon as 6 queries finish instead of
    // waiting for all 14. `fresh` (Refresh button) bypasses the server cache
    // too. Results merge into one `stats` object so the components read
    // open/closed/trend as before — they guard each sub-field since either
    // part can land first. Once BOTH real (non-mock) parts land we cache the
    // complete snapshot for instant navigation-back.
    const build = (part: "core" | "trend") => {
      const p = new URLSearchParams(qs);
      p.set("part", part);
      if (fresh) p.set("fresh", "1");
      return `/api/stats?${p.toString()}`;
    };
    const acc: Partial<DashboardStats> = {};
    let coreReal = false, trendReal = false;
    const maybeCache = () => {
      if (coreReal && trendReal && acc.open && acc.closed && acc.trend && acc.scope && acc.generatedAt) {
        setCachedStats(qs, acc as DashboardStats);
      }
    };

    setLoadingStats(true);
    fetch(build("core"))
      .then(r => r.json())
      .then((core: Partial<DashboardStats> & { source?: string }) => {
        coreReal = core.source === "bugzilla-mcp";
        acc.scope = core.scope ?? acc.scope;
        acc.open = core.open;
        acc.closed = core.closed;
        acc.generatedAt = core.generatedAt ?? acc.generatedAt;
        setStats(prev => ({
          ...(prev ?? {}),
          scope: core.scope ?? prev?.scope,
          open: core.open,
          closed: core.closed,
          generatedAt: core.generatedAt ?? prev?.generatedAt,
        } as DashboardStats));
        maybeCache();
      })
      .catch(() => { /* keep prior cards; loading flag clears below */ })
      .finally(() => setLoadingStats(false));

    setLoadingTrend(true);
    fetch(build("trend"))
      .then(r => r.json())
      .then((t: Partial<DashboardStats> & { source?: string }) => {
        trendReal = t.source === "bugzilla-mcp";
        acc.scope = t.scope ?? acc.scope;
        acc.trend = t.trend;
        acc.generatedAt = t.generatedAt ?? acc.generatedAt;
        setStats(prev => ({
          ...(prev ?? {}),
          scope: t.scope ?? prev?.scope,
          trend: t.trend,
          generatedAt: t.generatedAt ?? prev?.generatedAt,
        } as DashboardStats));
        maybeCache();
      })
      .catch(() => { /* keep prior trend; loading flag clears below */ })
      .finally(() => setLoadingTrend(false));
  }, []);

  // When the scope (excluding limit) changes, reset pagination to page 1.
  // The two effects below split tickets from stats: stats don't paginate.
  // Both gate on `configured === true` so we don't hit the API on first
  // run before the user has entered Bugzilla credentials.
  useEffect(() => {
    if (!scopeReady) return;
    if (filters.myTickets && !whoami?.login) return;
    setTicketLimit(PAGE_SIZE);
    loadStats(serverQuery);
  }, [scopeReady, serverQuery, filters.myTickets, whoami?.login, loadStats]);

  useEffect(() => {
    if (!scopeReady) return;
    if (filters.myTickets && !whoami?.login) return;
    loadTickets(ticketQuery);
  }, [scopeReady, ticketQuery, filters.myTickets, whoami?.login, loadTickets]);

  // ── Direct ticket-ID lookup ──────────────────────────────────────────
  // When the user types a pure numeric query (e.g. "14553"), the client-
  // side filter alone can't surface that ticket unless it happens to be
  // in the currently-loaded page window. We special-case this: debounce
  // the query, fetch /api/tickets/<id> directly, and prepend the result
  // into the filtered list so the ticket shows up regardless of the
  // active scope (product / component / status / bucket). Empty/non-
  // numeric / already-loaded queries skip the fetch entirely.
  const [directHit, setDirectHit] = useState<TicketSummary | null>(null);
  const [directLookupState, setDirectLookupState] =
    useState<"idle" | "loading" | "not-found">("idle");

  useEffect(() => {
    const q = filters.q.trim();
    if (!q || !/^\d+$/.test(q)) {
      setDirectHit(null);
      setDirectLookupState("idle");
      return;
    }
    const targetId = parseInt(q, 10);
    if (!targetId) {
      setDirectHit(null);
      setDirectLookupState("idle");
      return;
    }
    // Already in the loaded list → the client-side filter handles it.
    // Also covers the case where the user pasted an id that happens to
    // be visible right now.
    if (tickets.some(t => t.id === targetId)) {
      setDirectHit(null);
      setDirectLookupState("idle");
      return;
    }
    // If the previous direct-hit happened to be the same id (typing
    // "1455" → "14553"), keep it visible while we re-fetch.
    if (directHit?.id !== targetId) setDirectHit(null);
    setDirectLookupState("loading");
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/tickets/${targetId}`);
        if (cancelled) return;
        if (!res.ok) {
          // 404 from Bugzilla (no such ticket) OR 502 (Bugzilla down /
          // perms). Both render as "not found" — the user can re-check
          // the number or open Bugzilla directly.
          setDirectHit(null);
          setDirectLookupState("not-found");
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        if (data?.ticket) {
          setDirectHit(data.ticket as TicketSummary);
          setDirectLookupState("idle");
        } else {
          setDirectHit(null);
          setDirectLookupState("not-found");
        }
      } catch {
        if (cancelled) return;
        setDirectHit(null);
        setDirectLookupState("not-found");
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
    // `directHit?.id` is included so a switch from one direct hit to
    // another mid-typing doesn't leave stale UI.
  }, [filters.q, tickets, directHit?.id]);

  // ── Client-side narrowing for the freetext box ───────────────────────
  // Three cases:
  //
  //  1. Empty query → no narrowing, show everything `tickets` returned.
  //  2. Numeric query → server-side direct ID lookup pins `directHit` at
  //     the top; we still re-filter the loaded list so other tickets
  //     containing those digits in their id/summary/etc. also rank.
  //  3. Non-numeric query (length ≥ 2) → Bugzilla's quicksearch already
  //     filtered server-side (potentially matching against comments /
  //     description / fields the client doesn't have). Re-filtering here
  //     with `summary.includes(q)` would DROP server-returned tickets
  //     that matched on description — so we trust the server and skip
  //     the client filter for this case.
  //
  // Shorter non-numeric queries (1 char) are too noisy for server search
  // so they bypass the debounce → fall back to client-side narrowing on
  // whatever's loaded, which is fine.
  const filtered = useMemo(() => {
    const base = directHit
      ? [directHit, ...tickets.filter(t => t.id !== directHit.id)]
      : tickets;
    if (!filters.q) return base;
    const trimmed = filters.q.trim();
    const isServerHandled = !/^\d+$/.test(trimmed) && trimmed.length >= 2;
    if (isServerHandled) return base;   // server already filtered
    const q = filters.q.toLowerCase();
    return base.filter(t =>
      t.summary.toLowerCase().includes(q) ||
      String(t.id).includes(q) ||
      t.assignee.toLowerCase().includes(q) ||
      t.component.toLowerCase().includes(q),
    );
  }, [tickets, directHit, filters.q]);

  const componentsFromLoaded = useMemo(
    () => Array.from(new Set(tickets.map(t => t.component))).sort(),
    [tickets],
  );

  // Assignees observed in the currently-loaded tickets, deduplicated and
  // alphabetized. Mirrors the componentsFromLoaded pattern — the
  // dropdown narrows as the scope narrows. Filters out empty/undefined
  // assignees (Bugzilla can omit the field on some imported bugs).
  const assigneesFromLoaded = useMemo(
    () => Array.from(
      new Set(tickets.map(t => t.assignee).filter(Boolean) as string[])
    ).sort(),
    [tickets],
  );

  const scopeLabel = useMemo(() => {
    const parts: string[] = [];
    if (filters.product) parts.push(filters.product);
    if (filters.component) parts.push(filters.component);
    if (filters.assignee && !filters.myTickets) parts.push(`@${filters.assignee.split("@")[0]}`);
    if (filters.myTickets && whoami?.login) parts.push(`@${whoami.login.split("@")[0]}`);
    return parts.length ? parts.join(" · ") : "all products";
  }, [filters.product, filters.component, filters.myTickets, whoami?.login]);

  const refreshAll = useCallback(() => {
    // The Refresh button is the explicit "give me current data" action — it
    // bypasses BOTH the client snapshot cache and the 24h server cache for
    // tickets and stats alike.
    loadTickets(ticketQuery, /*fresh=*/ true);
    loadStats(serverQuery, /*fresh=*/ true);
  }, [ticketQuery, serverQuery, loadTickets, loadStats]);

  // Bucket selection from ProductStatus cards. Clears the severity/status
  // dropdowns so they don't visually conflict with the active bucket.
  const handleSelectBucket = useCallback((b: TicketBucket | null) => {
    setAssistantResults(null);   // status-card filter takes over from any Ask Zilla result set
    setBucket(b);
    if (b) setFilters(f => ({ ...f, severity: "", status: "" }));
  }, []);

  // Picking a severity/status from the dropdown clears any active bucket.
  const handleFiltersChange = useCallback((next: FilterState) => {
    // Applying any filter takes over from an Ask Zilla result set: otherwise the
    // table keeps showing `assistantResults` (it overrides `filtered`) and the
    // filter looks inert. Clearing it makes the filter immediately active; the
    // underlying filtered view is what the user now wants to browse.
    setAssistantResults(null);
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
    <div className="min-h-screen" style={{ paddingRight: askWidth }}>
      <header className="border-b border-bg-border bg-bg-panel/60 backdrop-blur-sm sticky top-0 z-20">
        <div className="w-full px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between">
          <div className="flex items-center">
            <Logo />
            <HeaderNav />
          </div>
          <div className="flex items-center gap-3">
            {whoami?.login && (
              <span className="text-[11px] text-slate-500">
                signed in as <span className="text-slate-300">{whoami.login}</span>
              </span>
            )}
            <SourceIndicator source={source} />
            <button onClick={refreshAll} disabled={loadingTickets || loadingStats || !configured}
                    className="btn-secondary text-xs py-1.5 px-3">
              <RefreshCw className={`w-3.5 h-3.5 ${(loadingTickets || loadingStats) ? "animate-spin" : ""}`} />
              Refresh
            </button>
            <Link href="/settings" className="btn-ghost text-xs py-1.5 px-2" title="Settings">
              <SettingsIcon className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </header>

      <main className="w-full px-4 sm:px-6 lg:px-8 py-6 space-y-5">
        {/* First-launch nudge for installing the optional 3GPP RAG corpus.
            Self-hides once installed or after the user dismisses it. */}
        {!multiUser && <CorpusInstallBanner />}

        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-xl font-semibold text-slate-100">Triage Queue</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              AI-assisted bug triage with human approval. All Bugzilla writes are gated by your review.
            </p>
          </div>
          <div className="text-xs text-slate-500 text-right">
            <div>
              Showing <span className="text-slate-300 font-medium">{filtered.length}</span>
              {filters.q && filtered.length !== tickets.length && (
                <span> of <span className="text-slate-300">{tickets.length}</span> loaded</span>
              )}
              {hasMore && <span className="text-slate-500"> (more available — Load more below)</span>}
            </div>
            {/* Non-numeric search states. Three flavours:
                  - pending debounce (user is still typing)
                  - in-flight (Bugzilla quicksearch fetching)
                  - settled (results loaded; subsumed by the "Showing N" count)
                Numeric search has its own direct-id loader/not-found chips. */}
            {(() => {
              const trimmed = filters.q.trim();
              const isNumeric = /^\d+$/.test(trimmed);
              const longEnough = trimmed.length >= 2;
              if (!isNumeric && longEnough && trimmed !== debouncedQ) {
                return (
                  <div className="text-[11px] text-slate-500 mt-0.5 inline-flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Searching Bugzilla for &ldquo;{trimmed}&rdquo;…
                  </div>
                );
              }
              if (!isNumeric && longEnough && debouncedQ === trimmed && loadingTickets) {
                return (
                  <div className="text-[11px] text-slate-500 mt-0.5 inline-flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Searching Bugzilla for &ldquo;{trimmed}&rdquo;…
                  </div>
                );
              }
              return null;
            })()}
            {directLookupState === "loading" && (
              <div className="text-[11px] text-slate-500 mt-0.5 inline-flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Looking up #{filters.q.trim()}…
              </div>
            )}
            {directLookupState === "not-found" && (
              <div className="text-[11px] text-amber-400/80 mt-0.5">
                Ticket #{filters.q.trim()} not found
              </div>
            )}
            {directHit && (
              <div className="text-[11px] text-accent-glow mt-0.5">
                Pinned ticket #{directHit.id} (outside current scope)
              </div>
            )}
          </div>
        </div>

        {/* First-run banner — shown until the user enters Bugzilla creds.
            Replaces the entire dashboard body so we don't fire any fetches
            that would only error against an unset URL. */}
        {configured === false && (
          <div className="card border-amber-500/40 bg-amber-950/20 p-6 flex items-start gap-4 animate-fade-in">
            <AlertCircle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="text-base text-slate-100 font-medium">
                Welcome — connect to your Bugzilla to get started
              </div>
              <p className="text-sm text-slate-400">
                The dashboard needs your Bugzilla URL, API key, and login email before it
                can load tickets. Open Settings to enter them; nothing leaves your machine
                except direct REST calls to your Bugzilla server.
              </p>
              <Link href="/settings" className="btn-primary text-sm inline-flex mt-2">
                <SettingsIcon className="w-3.5 h-3.5" />
                Open Settings
              </Link>
            </div>
          </div>
        )}

        {configured && error && (
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
          loading={loadingTrend}
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
              assigneeOptions={assigneesFromLoaded}
              whoami={whoami}
              bucketActive={bucket !== null}
              onFileTicket={() => setFileTicketOpen(true)}
              onAsk={() => setAskOpen(true)}
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

        {assistantResults && (
          <div className="flex items-center gap-2 text-xs animate-fade-in">
            <span className="badge bg-accent/15 text-accent-glow ring-1 ring-accent/40 flex items-center gap-1">✨ {assistantResults.length} result{assistantResults.length === 1 ? "" : "s"} from Ask Zilla</span>
            <button onClick={() => setAssistantResults(null)} className="text-slate-500 hover:text-slate-300 underline">clear, back to filters</button>
          </div>
        )}

        <TicketTable
          tickets={assistantResults ?? filtered}
          loading={loadingTickets && !assistantResults}
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

      <AskZillaPanel
        open={askOpen}
        onClose={() => setAskOpen(false)}
        onWidthChange={setAskWidth}
        onTickets={setAssistantResults}
        context={`The user is viewing the dashboard. Current product filter: ${filters.product || DEFAULT_PRODUCT}.`}
        seed={filters.q}
      />

      <FileTicketDialog
        open={fileTicketOpen}
        onClose={() => setFileTicketOpen(false)}
        products={products}
        typeOptions={typeOptions}
        defaultProduct={filters.product || DEFAULT_PRODUCT}
      />
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
