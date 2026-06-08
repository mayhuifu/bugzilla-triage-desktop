"use client";

// ──────────────────────────────────────────────────────────────────
// SpecResultList — renders the ranked /spec search results, plus the
// empty / loading / no-corpus states. Pure presentation; the page owns
// fetching and drawer state.
// ──────────────────────────────────────────────────────────────────

import Link from "next/link";
import { Loader2, SearchX, Database, BookOpen } from "lucide-react";
import { SpecResultCard, type SpecSearchResult } from "./SpecResultCard";

interface Props {
  results: SpecSearchResult[];
  loading: boolean;
  query: string;
  corpusInstalled: boolean;
  onOpen: (citation: string, title?: string) => void;
  onCreateTicket?: (result: SpecSearchResult) => void;
  ranking?: "hybrid" | "llm";
}

export function SpecResultList({
  results, loading, query, corpusInstalled, onOpen, onCreateTicket, ranking,
}: Props) {
  // No corpus downloaded yet — point the user at Settings rather than
  // showing an empty result list that looks like a search miss.
  if (!corpusInstalled) {
    return (
      <div className="card p-6 flex items-start gap-4 border-amber-500/30 bg-amber-950/10">
        <Database className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
        <div className="space-y-2">
          <div className="text-base text-slate-100 font-medium">
            The 3GPP spec corpus isn&apos;t installed yet
          </div>
          <p className="text-sm text-slate-400">
            Spec search runs entirely on your machine against a downloaded
            Rel-17 corpus (~68 MB). Install it once from Settings, then
            search works offline — no API key, no LLM required.
          </p>
          <Link href="/settings" className="btn-primary text-sm inline-flex mt-1">
            <Database className="w-3.5 h-3.5" />
            Open Settings → download corpus
          </Link>
        </div>
      </div>
    );
  }

  if (loading && results.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-400 py-8 justify-center">
        <Loader2 className="w-4 h-4 animate-spin text-accent" />
        Searching the local corpus…
      </div>
    );
  }

  if (!query) {
    return (
      <div className="text-center text-sm text-slate-500 py-12 space-y-2">
        <BookOpen className="w-8 h-8 mx-auto text-slate-700" />
        <div>Search 12,930 leaf clauses across 36 Rel-17 NR + LTE specs.</div>
        <div className="text-xs text-slate-600">
          Try <span className="font-mono text-slate-400">BWP switching after handover</span>,{" "}
          <span className="font-mono text-slate-400">TS 38.331 §5.3.5</span>, or{" "}
          <span className="font-mono text-slate-400">HARQ</span>.
        </div>
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="text-center text-sm text-slate-500 py-12 space-y-2">
        <SearchX className="w-8 h-8 mx-auto text-slate-700" />
        <div>No clauses matched &ldquo;{query}&rdquo;.</div>
        <div className="text-xs text-slate-600">
          Try fewer / different terms, or a specific citation like{" "}
          <span className="font-mono text-slate-400">TS 38.211 §6.3.1.1</span>.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {results.map((r, i) => (
        <SpecResultCard
          key={r.clauseId || i}
          result={r}
          rank={i + 1}
          onOpen={onOpen}
          onCreateTicket={onCreateTicket}
          ranking={ranking}
        />
      ))}
    </div>
  );
}
