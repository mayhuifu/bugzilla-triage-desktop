"use client";

import type { DashboardStats, TicketBucket } from "@/lib/types";
import {
  Ticket, AlertOctagon, Flame, CheckCircle2, ShieldCheck,
  TrendingUp, TrendingDown, Minus, ArrowUpRight, ArrowDownRight, Loader2,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────
// Product status (open + closed snapshot, B/C breakdown)
// Cards are clickable — selecting one drives the ticket table below
// via the `bucket` filter. Selecting the active card again clears it.
// ─────────────────────────────────────────────────────────────────
export function ProductStatus({
  stats,
  loading,
  scopeLabel,
  activeBucket,
  onSelectBucket,
}: {
  stats: DashboardStats | null;
  loading: boolean;
  scopeLabel: string;
  activeBucket: TicketBucket | null;
  onSelectBucket: (bucket: TicketBucket | null) => void;
}) {
  type Cell = {
    label: string; value: number; bucket: TicketBucket;
    icon: typeof Ticket; accent: string; glow: string;
  };
  const cells: Cell[] = stats ? [
    { label: "Open total",     value: stats.open.total,      bucket: "open",            icon: Ticket,        accent: "text-slate-200",  glow: "" },
    { label: "Open Blocker",   value: stats.open.blocker,    bucket: "open-blocker",    icon: AlertOctagon,  accent: "text-red-400",    glow: "shadow-[0_0_20px_-6px_rgba(239,68,68,0.5)]" },
    { label: "Open Critical",  value: stats.open.critical,   bucket: "open-critical",   icon: Flame,         accent: "text-orange-400", glow: "shadow-[0_0_20px_-6px_rgba(249,115,22,0.5)]" },
    { label: "Closed total",   value: stats.closed.total,    bucket: "closed",          icon: CheckCircle2,  accent: "text-emerald-300", glow: "" },
    { label: "Closed Blocker", value: stats.closed.blocker,  bucket: "closed-blocker",  icon: ShieldCheck,   accent: "text-emerald-300", glow: "" },
    { label: "Closed Critical",value: stats.closed.critical, bucket: "closed-critical", icon: ShieldCheck,   accent: "text-emerald-300", glow: "" },
  ] : [];

  return (
    <section>
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-medium text-slate-300 flex items-center gap-2">
          Product status <span className="text-slate-500 font-normal">· {scopeLabel}</span>
          {loading && stats && (
            <span className="badge bg-accent/10 text-accent-glow ring-1 ring-accent/30 text-[10px] flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              refreshing
            </span>
          )}
        </h2>
      </div>

      <div className={`grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 transition-opacity ${loading && stats ? "opacity-50" : ""}`}>
        {!stats && Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card p-4 animate-pulse">
            <div className="h-3 w-20 bg-bg-border rounded" />
            <div className="h-7 w-12 bg-bg-border rounded mt-3" />
          </div>
        ))}
        {cells.map(c => {
          const Icon = c.icon;
          const isActive = activeBucket === c.bucket;
          // Toggle: clicking the active card clears the bucket filter.
          const onClick = () => onSelectBucket(isActive ? null : c.bucket);
          return (
            <button
              key={c.label}
              onClick={onClick}
              aria-pressed={isActive}
              title={isActive ? "Click to clear filter" : "Filter ticket list"}
              className={`card p-4 text-left transition-all hover:bg-bg-panel/80 focus:outline-none ${c.glow} ${
                isActive
                  ? "ring-2 ring-accent shadow-[0_0_24px_-4px_rgba(168,85,247,0.6)]"
                  : "ring-1 ring-transparent hover:ring-bg-border"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="text-[11px] uppercase tracking-wider text-slate-500">{c.label}</div>
                <Icon className={`w-4 h-4 ${c.accent}`} />
              </div>
              <div className={`text-2xl font-bold mt-2 ${c.accent}`}>{c.value}</div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────
// 7-day trend + week-over-week delta + net-flow projection
// Cards are clickable — selecting one filters the ticket table below
// to the rows that contributed to that metric (date-window bucket).
// ─────────────────────────────────────────────────────────────────
export function TrendBar({
  stats,
  loading,
  activeBucket,
  onSelectBucket,
}: {
  stats: DashboardStats | null;
  loading: boolean;
  activeBucket: TicketBucket | null;
  onSelectBucket: (bucket: TicketBucket | null) => void;
}) {
  if (!stats && !loading) return null;

  type Metric = { label: string; now: number; prev: number; higherIsWorse: boolean; bucket: TicketBucket };
  const metrics: Metric[] = stats ? [
    { label: "New filed",       now: stats.trend.last7d.filed,    prev: stats.trend.prev7d.filed,    higherIsWorse: true,  bucket: "last7d-filed" },
    { label: "New filed (B+C)", now: stats.trend.last7d.filedBC,  prev: stats.trend.prev7d.filedBC,  higherIsWorse: true,  bucket: "last7d-filed-bc" },
    { label: "Closed",          now: stats.trend.last7d.closed,   prev: stats.trend.prev7d.closed,   higherIsWorse: false, bucket: "last7d-closed" },
    { label: "Closed (B+C)",    now: stats.trend.last7d.closedBC, prev: stats.trend.prev7d.closedBC, higherIsWorse: false, bucket: "last7d-closed-bc" },
  ] : [];

  const netFlow = stats?.trend.netFlowPerWeek ?? 0;
  const trajectory = formatTrajectory(netFlow);

  return (
    <section>
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-medium text-slate-300 flex items-center gap-2">
          Last 7 days <span className="text-slate-500 font-normal">· vs previous 7 days</span>
          {loading && stats && (
            <span className="badge bg-accent/10 text-accent-glow ring-1 ring-accent/30 text-[10px] flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              refreshing
            </span>
          )}
        </h2>
        {stats && (
          <div className={`text-[11px] flex items-center gap-1.5 ${trajectory.tone}`}>
            <trajectory.Icon className="w-3.5 h-3.5" />
            <span className="font-medium">{trajectory.label}</span>
          </div>
        )}
      </div>

      <div className={`grid grid-cols-2 md:grid-cols-4 gap-3 transition-opacity ${loading && stats ? "opacity-50" : ""}`}>
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
          const isUp = delta > 0;
          const isDown = delta < 0;
          const Arrow = isUp ? ArrowUpRight : isDown ? ArrowDownRight : Minus;
          const tone =
            delta === 0 ? "text-slate-500" :
            (isUp === m.higherIsWorse) ? "text-amber-400" : "text-emerald-400";

          const isActive = activeBucket === m.bucket;
          const onClick = () => onSelectBucket(isActive ? null : m.bucket);
          return (
            <button
              key={m.label}
              onClick={onClick}
              aria-pressed={isActive}
              title={isActive ? "Click to clear filter" : "Filter ticket list"}
              className={`card p-4 text-left transition-all hover:bg-bg-panel/80 focus:outline-none ${
                isActive
                  ? "ring-2 ring-accent shadow-[0_0_24px_-4px_rgba(168,85,247,0.6)]"
                  : "ring-1 ring-transparent hover:ring-bg-border"
              }`}
            >
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
            </button>
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
