"use client";

import type { DashboardStats } from "@/lib/types";
import {
  Ticket, AlertOctagon, Flame, CheckCircle2, ShieldCheck,
  TrendingUp, TrendingDown, Minus, ArrowUpRight, ArrowDownRight, Loader2,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────
// Product status (open + closed snapshot, B/C breakdown)
// ─────────────────────────────────────────────────────────────────
export function ProductStatus({
  stats,
  loading,
  scopeLabel,
}: {
  stats: DashboardStats | null;
  loading: boolean;
  scopeLabel: string;
}) {
  const cells = stats ? [
    { label: "Open total",     value: stats.open.total,      icon: Ticket,        accent: "text-slate-200",  glow: "" },
    { label: "Open Blocker",   value: stats.open.blocker,    icon: AlertOctagon,  accent: "text-red-400",    glow: "shadow-[0_0_20px_-6px_rgba(239,68,68,0.5)]" },
    { label: "Open Critical",  value: stats.open.critical,   icon: Flame,         accent: "text-orange-400", glow: "shadow-[0_0_20px_-6px_rgba(249,115,22,0.5)]" },
    { label: "Closed total",   value: stats.closed.total,    icon: CheckCircle2,  accent: "text-emerald-300", glow: "" },
    { label: "Closed Blocker", value: stats.closed.blocker,  icon: ShieldCheck,   accent: "text-emerald-300", glow: "" },
    { label: "Closed Critical",value: stats.closed.critical, icon: ShieldCheck,   accent: "text-emerald-300", glow: "" },
  ] : [];

  return (
    <section>
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-medium text-slate-300">
          Product status <span className="text-slate-500 font-normal">· {scopeLabel}</span>
        </h2>
        {loading && (
          <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <Loader2 className="w-3 h-3 animate-spin" /> updating…
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {!stats && Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card p-4 animate-pulse">
            <div className="h-3 w-20 bg-bg-border rounded" />
            <div className="h-7 w-12 bg-bg-border rounded mt-3" />
          </div>
        ))}
        {cells.map(c => {
          const Icon = c.icon;
          return (
            <div key={c.label} className={`card p-4 ${c.glow}`}>
              <div className="flex items-center justify-between">
                <div className="text-[11px] uppercase tracking-wider text-slate-500">{c.label}</div>
                <Icon className={`w-4 h-4 ${c.accent}`} />
              </div>
              <div className={`text-2xl font-bold mt-2 ${c.accent}`}>{c.value}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────
// 7-day trend + week-over-week delta + net-flow projection
// ─────────────────────────────────────────────────────────────────
export function TrendBar({
  stats,
  loading,
}: {
  stats: DashboardStats | null;
  loading: boolean;
}) {
  if (!stats && !loading) return null;

  const metrics = stats ? [
    { label: "New filed",         now: stats.trend.last7d.filed,    prev: stats.trend.prev7d.filed,    higherIsWorse: true },
    { label: "New filed (B+C)",   now: stats.trend.last7d.filedBC,  prev: stats.trend.prev7d.filedBC,  higherIsWorse: true },
    { label: "Closed",            now: stats.trend.last7d.closed,   prev: stats.trend.prev7d.closed,   higherIsWorse: false },
    { label: "Closed (B+C)",      now: stats.trend.last7d.closedBC, prev: stats.trend.prev7d.closedBC, higherIsWorse: false },
  ] : [];

  const netFlow = stats?.trend.netFlowPerWeek ?? 0;
  const trajectory = formatTrajectory(netFlow);

  return (
    <section>
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-medium text-slate-300">
          Last 7 days <span className="text-slate-500 font-normal">· vs previous 7 days</span>
        </h2>
        {stats && (
          <div className={`text-[11px] flex items-center gap-1.5 ${trajectory.tone}`}>
            <trajectory.Icon className="w-3.5 h-3.5" />
            <span className="font-medium">{trajectory.label}</span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {!stats && Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card p-4 animate-pulse">
            <div className="h-3 w-20 bg-bg-border rounded" />
            <div className="h-7 w-12 bg-bg-border rounded mt-3" />
            <div className="h-3 w-16 bg-bg-border rounded mt-2" />
          </div>
        ))}
        {metrics.map(m => {
          const delta = m.now - m.prev;
          const pct = m.prev === 0
            ? (m.now === 0 ? 0 : 100)
            : Math.round((delta / m.prev) * 100);
          // For "filed" (higherIsWorse): up = red, down = green
          // For "closed" (higherIsWorse=false): up = green, down = amber
          const isUp = delta > 0;
          const isDown = delta < 0;
          const Arrow = isUp ? ArrowUpRight : isDown ? ArrowDownRight : Minus;
          const tone =
            delta === 0 ? "text-slate-500" :
            (isUp === m.higherIsWorse) ? "text-amber-400" : "text-emerald-400";

          return (
            <div key={m.label} className="card p-4">
              <div className="text-[11px] uppercase tracking-wider text-slate-500">{m.label}</div>
              <div className="text-2xl font-bold mt-2 text-slate-100">{m.now}</div>
              <div className={`flex items-center gap-1 mt-1 text-[11px] ${tone}`}>
                <Arrow className="w-3 h-3" />
                <span>
                  {delta === 0
                    ? "no change"
                    : `${delta > 0 ? "+" : ""}${delta} (${pct > 0 ? "+" : ""}${pct}%)`}
                </span>
                <span className="text-slate-600">vs prev 7d ({m.prev})</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function formatTrajectory(netFlowPerWeek: number): {
  label: string; tone: string; Icon: typeof TrendingUp;
} {
  // Project forward by 4 weeks at the current net rate to give a sense of
  // direction. This is a coarse linear extrapolation, not a forecast.
  const fourWeek = netFlowPerWeek * 4;
  if (netFlowPerWeek > 0) {
    return {
      label: `Backlog growing · +${netFlowPerWeek}/wk (≈ +${fourWeek} in 4 weeks)`,
      tone: "text-amber-400",
      Icon: TrendingUp,
    };
  }
  if (netFlowPerWeek < 0) {
    return {
      label: `Backlog shrinking · ${netFlowPerWeek}/wk (≈ ${fourWeek} in 4 weeks)`,
      tone: "text-emerald-400",
      Icon: TrendingDown,
    };
  }
  return { label: "Backlog flat this week", tone: "text-slate-400", Icon: Minus };
}
