"use client";

// ──────────────────────────────────────────────────────────────────
// SpecResultCard — one ranked clause in the /spec search result list.
// Citation · title · parent breadcrumb · snippet · figure/table chips.
// Clicking anywhere on the card (or the "View clause" button) opens the
// shared SpecDrawer for the full clause text + tables + figures.
// ──────────────────────────────────────────────────────────────────

import { BookText, Table2, ImageIcon, ArrowUpRight, FilePlus2 } from "lucide-react";

export interface SpecSearchResult {
  clauseId: string;
  citation: string;
  title: string;
  parentTitle?: string;
  snippet: string;
  score?: number;
  retrieverPath?: string;
  matchedAs?: "exact" | "ancestor";
  hasFigures?: boolean;
  hasTables?: boolean;
}

interface Props {
  result: SpecSearchResult;
  rank: number;
  onOpen: (citation: string, title?: string) => void;
  /** Optional cross-feature hook — when provided a "New ticket" affordance
   *  shows, prefilling a bug about this clause (Phase 5 glue). */
  onCreateTicket?: (result: SpecSearchResult) => void;
}

export function SpecResultCard({ result, rank, onOpen, onCreateTicket }: Props) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(result.citation, result.title)}
      onKeyDown={e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(result.citation, result.title);
        }
      }}
      className="card p-3.5 hover:ring-1 hover:ring-accent/40 hover:bg-bg-hover/30
                 transition-colors cursor-pointer group animate-fade-in"
    >
      <div className="flex items-start gap-3">
        <div className="w-7 h-7 rounded-md bg-gradient-to-br from-accent to-fuchsia-600
                        flex items-center justify-center shrink-0 mt-0.5">
          <BookText className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-mono font-semibold text-slate-100">
              {result.citation}
            </span>
            {result.matchedAs === "ancestor" && (
              <span className="badge bg-amber-500/10 text-amber-300/80 text-[10px]">
                nearest leaf
              </span>
            )}
            <span className="text-[10px] text-slate-600 font-mono ml-auto">#{rank}</span>
          </div>
          {result.title && (
            <div className="text-sm text-slate-200 mt-0.5 font-medium truncate" title={result.title}>
              {result.title}
            </div>
          )}
          {result.parentTitle && (
            <div className="text-[11px] text-slate-500 truncate" title={result.parentTitle}>
              within: {result.parentTitle}
            </div>
          )}
          {result.snippet && (
            <p className="text-xs text-slate-400 mt-1.5 leading-relaxed line-clamp-3">
              {result.snippet}
            </p>
          )}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {result.hasTables && (
              <span className="badge bg-bg-hover/60 text-slate-400 text-[10px] inline-flex items-center gap-1">
                <Table2 className="w-3 h-3" /> tables
              </span>
            )}
            {result.hasFigures && (
              <span className="badge bg-bg-hover/60 text-slate-400 text-[10px] inline-flex items-center gap-1">
                <ImageIcon className="w-3 h-3" /> figures
              </span>
            )}
            <span className="ml-auto inline-flex items-center gap-2">
              {onCreateTicket && (
                <button
                  onClick={e => { e.stopPropagation(); onCreateTicket(result); }}
                  className="btn-ghost text-[11px] py-1 px-2"
                  title="Create a Bugzilla ticket about this clause"
                >
                  <FilePlus2 className="w-3 h-3" />
                  New ticket
                </button>
              )}
              <span className="text-[11px] text-accent-glow inline-flex items-center gap-0.5
                               opacity-70 group-hover:opacity-100 transition-opacity">
                View clause <ArrowUpRight className="w-3 h-3" />
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
