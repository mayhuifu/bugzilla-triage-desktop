import type { TicketSummary } from "@/lib/types";
import { Ticket, AlertOctagon, Flame, Clock } from "lucide-react";

const OPEN = new Set(["NEW", "IN_PROGRESS", "IN_ANALYSIS", "WAITING_FOR_INFO", "ANALYZED", "INTEGRATED", "IN_VERIFICATION"]);

export function StatsBar({ tickets }: { tickets: TicketSummary[] }) {
  const open = tickets.filter(t => OPEN.has(t.status));
  const blockers = open.filter(t => t.severity === "Blocker").length;
  const critical = open.filter(t => t.severity === "Critical").length;
  const breached = open.filter(t => t.slaRisk === "breach").length;

  const stats = [
    { label: "Open tickets", value: open.length, icon: Ticket, accent: "text-slate-200", glow: "" },
    { label: "Blockers", value: blockers, icon: AlertOctagon, accent: "text-red-400", glow: "shadow-[0_0_20px_-6px_rgba(239,68,68,0.5)]" },
    { label: "Critical", value: critical, icon: Flame, accent: "text-orange-400", glow: "shadow-[0_0_20px_-6px_rgba(249,115,22,0.5)]" },
    { label: "SLA breached", value: breached, icon: Clock, accent: "text-amber-400", glow: "shadow-[0_0_20px_-6px_rgba(245,158,11,0.5)]" },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {stats.map(s => {
        const Icon = s.icon;
        return (
          <div key={s.label} className={`card p-4 ${s.glow}`}>
            <div className="flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-wider text-slate-500">{s.label}</div>
              <Icon className={`w-4 h-4 ${s.accent}`} />
            </div>
            <div className={`text-2xl font-bold mt-2 ${s.accent}`}>{s.value}</div>
          </div>
        );
      })}
    </div>
  );
}
