"use client";

// ──────────────────────────────────────────────────────────────────
// /spec — the 3GPP Spec Workbench (v0.5). Standalone spec search, NOT
// gated behind AI triage and requiring NO LLM: it runs the local
// corpus's hybrid (BM25 ⊕ dense ⊕ RRF) retrieval — or the BM25 fallback
// when no matching embedder is bundled — entirely offline.
//
// Layout A: search box → ranked result list → click a card → the shared
// SpecDrawer (resize + tables + figures, reused from the triage flow).
//
// Deep-linking: /spec?q=PUSCH+DMRS pre-runs a search; /spec?clause=TS+38.211+%C2%A77.4.2.2
// opens the drawer directly. Both are how cross-feature glue (e.g. a
// ticket's "Research in 3GPP" button) hands off to this page.
// ──────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Settings as SettingsIcon, Zap, Search as SearchIcon } from "lucide-react";
import { Logo } from "@/components/ui/Logo";
import { HeaderNav } from "@/components/ui/HeaderNav";
import { SpecSearchBox } from "@/components/spec/SpecSearchBox";
import { SpecResultList } from "@/components/spec/SpecResultList";
import type { SpecSearchResult } from "@/components/spec/SpecResultCard";
import { SpecAcronymPane } from "@/components/spec/SpecAcronymPane";
import { SpecTocSidebar, type RecentClause } from "@/components/spec/SpecTocSidebar";
import { SpecDrawer } from "@/components/triage/SpecDrawer";

const RECENT_LS_KEY = "bugzilla-triage:spec:recent";
const RECENT_MAX = 8;

interface SearchResponse {
  query: string;
  kind: string;
  corpusInstalled: boolean;
  retrieverPath: string;
  hybridActive: boolean;
  results: SpecSearchResult[];
}

export default function SpecPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SpecSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [corpusInstalled, setCorpusInstalled] = useState(true);
  const [retrieverPath, setRetrieverPath] = useState<string>("");
  const [hybridActive, setHybridActive] = useState(false);
  const [lastSearched, setLastSearched] = useState("");
  const [openCitation, setOpenCitation] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentClause[]>([]);
  // Monotonic request id so a slow earlier search can't clobber a faster
  // later one (the debounce fires overlapping fetches as the user types).
  const reqIdRef = useRef(0);

  // Load recently-viewed clauses once on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECENT_LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as RecentClause[];
        if (Array.isArray(parsed)) setRecent(parsed.slice(0, RECENT_MAX));
      }
    } catch { /* private mode / malformed — ignore */ }
  }, []);

  const recordRecent = useCallback((citation: string, title: string) => {
    setRecent(prev => {
      const next = [{ citation, title }, ...prev.filter(r => r.citation !== citation)].slice(0, RECENT_MAX);
      try { localStorage.setItem(RECENT_LS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const runSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) {
      setResults([]);
      setLastSearched("");
      return;
    }
    const myId = ++reqIdRef.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/corpus/search?q=${encodeURIComponent(trimmed)}&limit=25`);
      const data: SearchResponse = await res.json();
      if (myId !== reqIdRef.current) return; // a newer search already landed
      setResults(data.results || []);
      setCorpusInstalled(data.corpusInstalled);
      setRetrieverPath(data.retrieverPath || "");
      setHybridActive(!!data.hybridActive);
      setLastSearched(trimmed);
      // Deep-link the query so reload / back / share reproduces the search.
      const u = new URL(window.location.href);
      u.searchParams.set("q", trimmed);
      u.searchParams.delete("clause");
      window.history.replaceState(null, "", u.toString());
    } catch {
      if (myId !== reqIdRef.current) return;
      setResults([]);
    } finally {
      if (myId === reqIdRef.current) setLoading(false);
    }
  }, []);

  // ── Deep-link bootstrap (read once on mount) ──────────────────────
  // Reading window.location directly (rather than useSearchParams) keeps
  // this a plain client component with no Suspense boundary requirement.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const clause = params.get("clause");
    const q = params.get("q");
    if (clause) setOpenCitation(clause);
    if (q) {
      setQuery(q);
      runSearch(q);
    }
  }, [runSearch]);

  const onOpen = useCallback((citation: string, title = "") => {
    setOpenCitation(citation);
    recordRecent(citation, title);
    const u = new URL(window.location.href);
    u.searchParams.set("clause", citation);
    window.history.replaceState(null, "", u.toString());
  }, [recordRecent]);

  // Pivot the main search to a term (used by the acronym pane's
  // "search clauses" affordance).
  const onSearchTerm = useCallback((term: string) => {
    setQuery(term);
    runSearch(term);
  }, [runSearch]);

  const onCloseDrawer = useCallback(() => {
    setOpenCitation(null);
    const u = new URL(window.location.href);
    u.searchParams.delete("clause");
    window.history.replaceState(null, "", u.toString());
  }, []);

  return (
    <div className="min-h-screen">
      <header className="border-b border-bg-border bg-bg-panel/60 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-[1100px] mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center">
            <Logo />
            <HeaderNav />
          </div>
          <Link href="/settings" className="btn-ghost text-xs py-1.5 px-2" title="Settings">
            <SettingsIcon className="w-3.5 h-3.5" />
          </Link>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-6 py-6">
        <div className="flex items-baseline justify-between gap-4 flex-wrap mb-5">
          <div>
            <h1 className="text-xl font-semibold text-slate-100">3GPP Spec Search</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Look up Rel-17 NR &amp; LTE clauses by topic, citation, or acronym.
              Runs locally — no LLM, works offline.
            </p>
          </div>
          <RetrieverBadge installed={corpusInstalled} path={retrieverPath} hybrid={hybridActive} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] gap-6 items-start">
          {/* Left rail — browse + acronyms. Hidden on narrow screens to
              keep the search-first flow uncluttered on mobile. */}
          <aside className="hidden lg:block space-y-3 sticky top-20">
            <SpecAcronymPane onSearchTerm={onSearchTerm} />
            <SpecTocSidebar onOpen={onOpen} recent={recent} />
          </aside>

          {/* Main column — search + results. */}
          <div className="space-y-5 min-w-0">
            <SpecSearchBox
              value={query}
              onChange={setQuery}
              onSearch={runSearch}
              loading={loading}
            />

            {lastSearched && corpusInstalled && (
              <div className="text-xs text-slate-500 flex items-center gap-1.5">
                <SearchIcon className="w-3 h-3" />
                {results.length > 0
                  ? <>Top <span className="text-slate-300">{results.length}</span> clauses for &ldquo;{lastSearched}&rdquo;</>
                  : <>No matches for &ldquo;{lastSearched}&rdquo;</>}
              </div>
            )}

            <SpecResultList
              results={results}
              loading={loading}
              query={lastSearched}
              corpusInstalled={corpusInstalled}
              onOpen={onOpen}
            />
          </div>
        </div>
      </main>

      {/* Shared detail view — fetches /api/corpus/lookup for the citation. */}
      <SpecDrawer citation={openCitation} onClose={onCloseDrawer} />
    </div>
  );
}

/** Small chip telling the user whether semantic (hybrid) retrieval is
 *  active or we're on the BM25 keyword fallback. Surfaces the otherwise-
 *  silent "embedder model doesn't match corpus → BM25" degrade. */
function RetrieverBadge({
  installed, path, hybrid,
}: { installed: boolean; path: string; hybrid: boolean }) {
  if (!installed) return null;
  if (hybrid) {
    // Phase A / v0.5.5: the cross-encoder rerank layer sits on top of hybrid.
    // Surface it so the user knows the strongest retrieval path is engaged.
    const reranked = path === "hybrid-rrf+rerank";
    return (
      <span
        className="badge bg-emerald-500/10 text-emerald-300/90 ring-1 ring-emerald-500/30 inline-flex items-center gap-1.5"
        title={
          reranked
            ? "Hybrid retrieval (keyword BM25 + semantic vectors fused via RRF) refined by a cross-encoder reranker that reorders the top candidates for best top-1 relevance"
            : "Hybrid retrieval: keyword (BM25) + semantic (dense vectors) fused via RRF"
        }
      >
        <Zap className="w-3 h-3" />
        {reranked ? "Hybrid + rerank" : "Hybrid retrieval"}
      </span>
    );
  }
  return (
    <span
      className="badge bg-bg-hover/60 text-slate-400 inline-flex items-center gap-1.5"
      title={`Keyword (BM25) retrieval${path ? ` · ${path}` : ""}. Semantic search engages when a matching embedder + corpus are installed.`}
    >
      Keyword search
    </span>
  );
}
