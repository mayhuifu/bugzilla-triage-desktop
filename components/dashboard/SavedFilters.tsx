"use client";

import { useEffect, useRef, useState } from "react";
import { Bookmark, BookmarkPlus, X, ChevronDown } from "lucide-react";
import {
  loadSavedFilters, saveSavedFilter, deleteSavedFilter,
  type SavedFilter,
} from "@/lib/saved-filters";
import type { TicketBucket } from "@/lib/types";
import { BUCKET_LABELS } from "@/lib/types";
import type { FilterState } from "./TicketFilters";

// Dropdown that lists saved filters + a "Save current as…" affordance.
// Each entry is one click to apply; × button on hover deletes.
export function SavedFilters({
  currentFilters,
  currentBucket,
  onApply,
}: {
  currentFilters: FilterState;
  currentBucket: TicketBucket | null;
  onApply: (filters: FilterState, bucket: TicketBucket | null) => void;
}) {
  const [items, setItems] = useState<SavedFilter[]>([]);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setItems(loadSavedFilters()); }, []);

  // Close on click-outside. Pointerdown (not click) so it fires before the
  // browser dismisses native <option> elements rendered next to us.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const onSaveCurrent = () => {
    const name = window.prompt("Name this filter:");
    if (!name) return;
    setItems(prev => [saveSavedFilter(name, currentFilters, currentBucket), ...prev].slice(0, 20));
  };

  const onDelete = (id: string) => {
    setItems(deleteSavedFilter(id));
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        title="Saved filters"
        className={`input w-auto flex items-center gap-1.5 text-xs ${
          items.length ? "text-slate-300" : "text-slate-500"
        }`}
      >
        <Bookmark className="w-3.5 h-3.5" />
        Filters
        {items.length > 0 && (
          <span className="badge text-[10px] bg-bg-panel/80 text-slate-400 ring-1 ring-bg-border">
            {items.length}
          </span>
        )}
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-72 card p-1 z-30 shadow-xl ring-1 ring-bg-border animate-fade-in">
          <button
            onClick={() => { onSaveCurrent(); setOpen(false); }}
            className="w-full text-left px-2.5 py-2 rounded-md hover:bg-bg-hover/60 flex items-center gap-2 text-xs"
          >
            <BookmarkPlus className="w-3.5 h-3.5 text-accent" />
            <span className="text-slate-200">Save current filter…</span>
          </button>

          {items.length > 0 && <div className="my-1 border-t border-bg-border/60" />}

          <div className="max-h-72 overflow-y-auto">
            {items.length === 0 && (
              <div className="px-2.5 py-2 text-[11px] text-slate-500 italic">
                No saved filters yet. Configure product, component, status, or pick a
                card-filter, then click <span className="text-slate-300">Save current filter…</span>
              </div>
            )}
            {items.map(it => (
              <div
                key={it.id}
                className="group flex items-center gap-1 px-1 hover:bg-bg-hover/40 rounded-md"
              >
                <button
                  onClick={() => { onApply(it.filters, it.bucket); setOpen(false); }}
                  className="flex-1 text-left px-1.5 py-1.5 text-xs"
                  title="Apply this filter"
                >
                  <div className="text-slate-200 font-medium truncate">{it.name}</div>
                  <div className="text-[10px] text-slate-500 truncate">{describeFilter(it)}</div>
                </button>
                <button
                  onClick={() => onDelete(it.id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-slate-500 hover:text-red-400"
                  title="Delete this saved filter"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function describeFilter(it: SavedFilter): string {
  const parts: string[] = [];
  if (it.filters.product) parts.push(it.filters.product);
  if (it.filters.component) parts.push(it.filters.component);
  if (it.filters.myTickets) parts.push("My Tickets");
  // Show assignee (when not overridden by My Tickets) as `@username`.
  // Falsy-guard handles saved filters from before the assignee field
  // existed — those serialize without the property and we just skip it.
  if (it.filters.assignee && !it.filters.myTickets) {
    parts.push(`@${it.filters.assignee.split("@")[0]}`);
  }
  if (it.bucket) parts.push(BUCKET_LABELS[it.bucket]);
  if (it.filters.severity) parts.push(it.filters.severity);
  if (it.filters.status) parts.push(it.filters.status);
  if (it.filters.q) parts.push(`q="${it.filters.q}"`);
  return parts.join(" · ") || "(no scope)";
}
