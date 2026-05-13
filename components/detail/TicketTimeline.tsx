"use client";

import { History, ChevronRight } from "lucide-react";
import type { TicketHistoryEntry } from "@/lib/types";

export function TicketTimeline({ history }: { history: TicketHistoryEntry[] }) {
  if (!history.length) {
    return (
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-3">
          <History className="w-4 h-4 text-accent" />
          <div className="text-sm font-medium text-slate-200">Timeline</div>
        </div>
        <div className="text-sm text-slate-500 italic">No history events yet.</div>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-3">
        <History className="w-4 h-4 text-accent" />
        <div className="text-sm font-medium text-slate-200">
          Timeline <span className="text-slate-500 font-normal">({history.length})</span>
        </div>
      </div>
      <div className="space-y-3 max-h-72 overflow-y-auto pr-2">
        {history.map((h, i) => (
          <div key={i} className="flex gap-3 text-xs">
            <div className="flex flex-col items-center pt-1">
              <div className="w-2 h-2 rounded-full bg-accent ring-4 ring-accent/15" />
              {i < history.length - 1 && <div className="flex-1 w-px bg-bg-border my-1" />}
            </div>
            <div className="flex-1 pb-1">
              <div className="text-slate-400">
                <span className="font-medium text-slate-300">{h.who.split("@")[0]}</span>
                <span className="text-slate-600"> · {new Date(h.when).toLocaleString()}</span>
              </div>
              <div className="mt-1 space-y-0.5">
                {h.changes.map((c, j) => (
                  <div key={j} className="flex items-center gap-1.5 text-slate-500">
                    <span className="text-slate-600 font-medium">{c.field}:</span>
                    <span className="text-slate-500">{c.removed || "∅"}</span>
                    <ChevronRight className="w-3 h-3 text-slate-600" />
                    <span className="text-slate-300">{c.added}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
