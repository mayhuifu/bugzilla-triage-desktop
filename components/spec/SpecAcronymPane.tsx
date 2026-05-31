"use client";

// ──────────────────────────────────────────────────────────────────
// SpecAcronymPane — quick 3GPP acronym lookup over the corpus's curated
// glossary (152 entries). Engineers constantly need to expand acronyms
// (PUSCH, BWP, SRB…); this pane resolves them without leaving the page.
// "Search clauses" jumps the main search to the acronym so the user can
// pivot from definition → relevant clauses.
// ──────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { Search, X, ArrowRight } from "lucide-react";

interface AcronymRow {
  acronym: string;
  expansion: string;
  aliases: string[];
}

interface Props {
  /** Pivot the main search to a term (e.g. the acronym the user clicked). */
  onSearchTerm: (term: string) => void;
}

export function SpecAcronymPane({ onSearchTerm }: Props) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<AcronymRow[]>([]);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);

  useEffect(() => {
    const id = ++reqRef.current;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/corpus/acronym?q=${encodeURIComponent(q.trim())}&limit=${q.trim() ? 25 : 12}`);
        const data = await res.json();
        if (id !== reqRef.current) return;
        setRows(data.results || []);
      } catch {
        if (id === reqRef.current) setRows([]);
      } finally {
        if (id === reqRef.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="card p-3">
      <div className="text-[11px] uppercase tracking-wider text-slate-500 font-medium mb-2">
        Acronyms
      </div>
      <div className="flex items-center gap-2 rounded-md border border-bg-border bg-bg-card px-2 h-8 mb-2">
        <Search className="w-3.5 h-3.5 text-slate-500 shrink-0" />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="HARQ, BWP, SRB…"
          className="flex-1 bg-transparent outline-none text-xs text-slate-100 placeholder:text-slate-600 min-w-0"
          spellCheck={false}
          autoComplete="off"
        />
        {q && (
          <button onClick={() => setQ("")} className="btn-ghost p-0.5 shrink-0" aria-label="Clear">
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
      <div className="space-y-1.5 max-h-64 overflow-y-auto">
        {rows.length === 0 && !loading && (
          <div className="text-[11px] text-slate-600 py-2 text-center">
            {q ? "No matching acronym" : "Type to look up an acronym"}
          </div>
        )}
        {rows.map(r => (
          <div key={r.acronym} className="group flex items-start gap-2 text-xs">
            <span className="font-mono font-semibold text-slate-200 shrink-0">{r.acronym}</span>
            <span className="text-slate-400 leading-snug flex-1 min-w-0">{r.expansion}</span>
            <button
              onClick={() => onSearchTerm(r.acronym)}
              className="opacity-0 group-hover:opacity-100 transition-opacity text-accent-glow shrink-0"
              title={`Search clauses for ${r.acronym}`}
              aria-label={`Search clauses for ${r.acronym}`}
            >
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
