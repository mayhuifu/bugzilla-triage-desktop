"use client";

// ──────────────────────────────────────────────────────────────────
// SpecTocSidebar — browse the corpus by spec. Lists the 36 curated
// specs with clause counts; expanding one lazily fetches its leaf
// clauses (natural-sorted) for direct drilldown. Also shows a
// recently-viewed list (localStorage) so an engineer can jump back to
// clauses they just read. Clicking any clause opens the shared drawer.
// ──────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, ChevronDown, Loader2, History, Library } from "lucide-react";

interface SpecSummary { spec: string; count: number; }
interface TocClause {
  clauseId: string;
  clauseNo: string;
  citation: string;
  title: string;
  parentTitle: string | null;
}
export interface RecentClause { citation: string; title: string; }

interface Props {
  onOpen: (citation: string) => void;
  recent: RecentClause[];
}

export function SpecTocSidebar({ onOpen, recent }: Props) {
  const [specs, setSpecs] = useState<SpecSummary[]>([]);
  const [loadingSpecs, setLoadingSpecs] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [clauses, setClauses] = useState<Record<string, TocClause[]>>({});
  const [loadingSpec, setLoadingSpec] = useState<string | null>(null);
  const fetchedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    fetch("/api/corpus/toc")
      .then(r => r.json())
      .then(d => { if (!cancelled) setSpecs(d.specs || []); })
      .catch(() => { if (!cancelled) setSpecs([]); })
      .finally(() => { if (!cancelled) setLoadingSpecs(false); });
    return () => { cancelled = true; };
  }, []);

  const toggle = useCallback(async (spec: string) => {
    if (expanded === spec) { setExpanded(null); return; }
    setExpanded(spec);
    if (fetchedRef.current.has(spec)) return;
    fetchedRef.current.add(spec);
    setLoadingSpec(spec);
    try {
      const res = await fetch(`/api/corpus/toc?spec=${encodeURIComponent(spec)}`);
      const d = await res.json();
      setClauses(prev => ({ ...prev, [spec]: d.clauses || [] }));
    } catch {
      setClauses(prev => ({ ...prev, [spec]: [] }));
    } finally {
      setLoadingSpec(null);
    }
  }, [expanded]);

  return (
    <div className="space-y-3">
      {recent.length > 0 && (
        <div className="card p-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-500 font-medium mb-2 flex items-center gap-1.5">
            <History className="w-3 h-3" /> Recently viewed
          </div>
          <div className="space-y-1">
            {recent.map(r => (
              <button
                key={r.citation}
                onClick={() => onOpen(r.citation)}
                className="block w-full text-left text-xs text-slate-300 hover:text-accent-glow truncate"
                title={`${r.citation} — ${r.title}`}
              >
                <span className="font-mono">{r.citation.replace(/^3GPP /, "")}</span>
                {r.title && <span className="text-slate-500"> · {r.title}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card p-3">
        <div className="text-[11px] uppercase tracking-wider text-slate-500 font-medium mb-2 flex items-center gap-1.5">
          <Library className="w-3 h-3" /> Browse specs
        </div>
        {loadingSpecs ? (
          <div className="flex items-center gap-2 text-xs text-slate-500 py-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
          </div>
        ) : specs.length === 0 ? (
          <div className="text-[11px] text-slate-600 py-2">No corpus installed.</div>
        ) : (
          <div className="space-y-0.5 max-h-[60vh] overflow-y-auto -mx-1 px-1">
            {specs.map(s => {
              const isOpen = expanded === s.spec;
              const list = clauses[s.spec];
              return (
                <div key={s.spec}>
                  <button
                    onClick={() => toggle(s.spec)}
                    className="flex items-center gap-1.5 w-full text-left text-xs py-1 hover:text-slate-100 text-slate-300"
                    aria-expanded={isOpen}
                  >
                    {isOpen ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
                    <span className="font-mono">{s.spec}</span>
                    <span className="text-slate-600 ml-auto">{s.count}</span>
                  </button>
                  {isOpen && (
                    <div className="ml-4 border-l border-bg-border/50 pl-2 py-0.5 space-y-0.5">
                      {loadingSpec === s.spec ? (
                        <div className="flex items-center gap-1.5 text-[11px] text-slate-500 py-1">
                          <Loader2 className="w-3 h-3 animate-spin" /> Loading clauses…
                        </div>
                      ) : (list && list.length > 0) ? (
                        list.map(c => (
                          <button
                            key={c.clauseId}
                            onClick={() => onOpen(c.citation)}
                            className="block w-full text-left text-[11px] text-slate-400 hover:text-accent-glow truncate py-0.5"
                            title={`${c.clauseNo} ${c.title}`}
                          >
                            <span className="font-mono text-slate-500">{c.clauseNo}</span>{" "}
                            <span>{c.title}</span>
                          </button>
                        ))
                      ) : (
                        <div className="text-[11px] text-slate-600 py-1">No clauses.</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
