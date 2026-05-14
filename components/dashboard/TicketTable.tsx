"use client";

import Link from "next/link";
import { Sparkles, ExternalLink } from "lucide-react";
import type { TicketSummary } from "@/lib/types";
import { SeverityBadge, StatusBadge, SlaIndicator } from "@/components/ui/Badge";

export function TicketTable({
  tickets,
  loading,
  selectedIds,
  onToggleSelect,
  onToggleAll,
}: {
  tickets: TicketSummary[];
  loading: boolean;
  // Optional — when present, renders a checkbox column for bulk actions.
  // Kept optional so the table also works in views that don't need bulk
  // (e.g. a future read-only embedded view).
  selectedIds?: ReadonlySet<number>;
  onToggleSelect?: (id: number) => void;
  onToggleAll?: (allSelected: boolean) => void;
}) {
  if (loading) {
    return (
      <div className="card overflow-hidden">
        <div className="divide-y divide-bg-border">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex gap-4 px-4 py-3">
              <div className="skeleton h-4 w-16" />
              <div className="skeleton h-4 flex-1" />
              <div className="skeleton h-4 w-20" />
              <div className="skeleton h-4 w-20" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!tickets.length) {
    return (
      <div className="card p-12 text-center">
        <div className="w-12 h-12 rounded-full bg-bg-hover mx-auto flex items-center justify-center">
          <Sparkles className="w-5 h-5 text-slate-500" />
        </div>
        <div className="text-base font-medium text-slate-300 mt-4">No tickets match your filters</div>
        <div className="text-sm text-slate-500 mt-1">Try clearing search or filter selections.</div>
      </div>
    );
  }

  const selectable = Boolean(selectedIds && onToggleSelect);
  // "All selected" is computed across the currently rendered rows so the
  // header checkbox reflects "select / clear visible rows" semantics.
  const allSelected = selectable && tickets.every(t => selectedIds!.has(t.id));
  const someSelected = selectable && !allSelected && tickets.some(t => selectedIds!.has(t.id));

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-bg-border bg-bg-panel/50">
              {selectable && (
                <th className="px-3 py-2.5 w-10">
                  <input
                    type="checkbox"
                    aria-label="Select all visible tickets"
                    checked={allSelected}
                    ref={el => { if (el) el.indeterminate = someSelected; }}
                    onChange={() => onToggleAll?.(allSelected)}
                    className="w-3.5 h-3.5 accent-accent cursor-pointer"
                  />
                </th>
              )}
              <th className="text-left font-medium text-[11px] uppercase tracking-wider text-slate-500 px-4 py-2.5 w-20">ID</th>
              <th className="text-left font-medium text-[11px] uppercase tracking-wider text-slate-500 px-4 py-2.5">Summary</th>
              <th className="text-left font-medium text-[11px] uppercase tracking-wider text-slate-500 px-4 py-2.5">Component</th>
              <th className="text-left font-medium text-[11px] uppercase tracking-wider text-slate-500 px-4 py-2.5">Customer / Site</th>
              <th className="text-left font-medium text-[11px] uppercase tracking-wider text-slate-500 px-4 py-2.5">Severity</th>
              <th className="text-left font-medium text-[11px] uppercase tracking-wider text-slate-500 px-4 py-2.5">Status</th>
              <th className="text-left font-medium text-[11px] uppercase tracking-wider text-slate-500 px-4 py-2.5">Assignee</th>
              <th className="text-left font-medium text-[11px] uppercase tracking-wider text-slate-500 px-4 py-2.5">SLA / Age</th>
              <th className="text-right font-medium text-[11px] uppercase tracking-wider text-slate-500 px-4 py-2.5 w-32">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map(t => {
              const isSelected = selectable && selectedIds!.has(t.id);
              return (
              <tr
                key={t.id}
                className={`border-b border-bg-border/50 transition-colors group ${
                  isSelected ? "bg-accent/10 hover:bg-accent/15" : "hover:bg-bg-hover/40"
                }`}
              >
                {selectable && (
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ticket ${t.id}`}
                      checked={isSelected}
                      onChange={() => onToggleSelect!(t.id)}
                      className="w-3.5 h-3.5 accent-accent cursor-pointer"
                    />
                  </td>
                )}
                <td className="px-4 py-3 font-mono text-slate-400">#{t.id}</td>
                <td className="px-4 py-3 max-w-xl">
                  <Link href={`/tickets/${t.id}`} className="text-slate-100 hover:text-accent-glow line-clamp-2 font-medium">
                    {t.summary}
                  </Link>
                  {t.label === "Analyzed by Claude" && (
                    <div className="mt-1 inline-flex items-center gap-1 text-[10px] text-fuchsia-400/80">
                      <Sparkles className="w-3 h-3" /> previously analyzed by Claude
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-400">
                  <div className="text-slate-300">{t.component}</div>
                  <div className="text-[11px] text-slate-500">{t.product}</div>
                </td>
                <td className="px-4 py-3 text-slate-400">
                  {t.customer ? <span className="text-slate-300">{t.customer}</span> : <span className="text-slate-600">—</span>}
                </td>
                <td className="px-4 py-3"><SeverityBadge severity={t.severity} /></td>
                <td className="px-4 py-3"><StatusBadge status={t.status} /></td>
                <td className="px-4 py-3 text-slate-400">{t.assignee.split("@")[0]}</td>
                <td className="px-4 py-3"><SlaIndicator risk={t.slaRisk} ageDays={t.ageDays} /></td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1.5">
                    <Link
                      href={`/tickets/${t.id}`}
                      className="btn-ghost text-xs py-1 px-2 opacity-60 group-hover:opacity-100 transition-opacity"
                      title="Open ticket"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </Link>
                    <Link
                      href={`/tickets/${t.id}?autotriage=1`}
                      className="btn-primary text-xs py-1 px-3"
                      title="Run AI triage"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      Triage
                    </Link>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
