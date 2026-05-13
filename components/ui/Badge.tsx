import type { Severity, TicketStatus, SlaRisk } from "@/lib/types";

export function SeverityBadge({ severity }: { severity: Severity }) {
  const map: Record<Severity, string> = {
    Blocker: "bg-red-600/15 text-red-400 ring-1 ring-red-600/40",
    Critical: "bg-orange-600/15 text-orange-400 ring-1 ring-orange-600/40",
    Major: "bg-amber-600/15 text-amber-400 ring-1 ring-amber-600/40",
    Normal: "bg-slate-500/15 text-slate-300 ring-1 ring-slate-500/30",
    Minor: "bg-slate-600/10 text-slate-400 ring-1 ring-slate-600/30",
    Trivial: "bg-slate-600/10 text-slate-400 ring-1 ring-slate-600/30",
    Enhancement: "bg-blue-600/10 text-blue-400 ring-1 ring-blue-600/30",
  };
  return (
    <span className={`badge ${map[severity] || map.Normal}`}>
      {severity === "Blocker" && <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse-glow" />}
      {severity === "Critical" && <span className="w-1.5 h-1.5 rounded-full bg-orange-500" />}
      {severity}
    </span>
  );
}

export function StatusBadge({ status }: { status: TicketStatus }) {
  const map: Record<TicketStatus, string> = {
    NEW: "bg-blue-500/15 text-blue-300 ring-1 ring-blue-500/30",
    IN_PROGRESS: "bg-purple-500/15 text-purple-300 ring-1 ring-purple-500/30",
    IN_ANALYSIS: "bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/30",
    WAITING_FOR_INFO: "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30",
    ANALYZED: "bg-fuchsia-500/15 text-fuchsia-300 ring-1 ring-fuchsia-500/30",
    INTEGRATED: "bg-teal-500/15 text-teal-300 ring-1 ring-teal-500/30",
    IN_VERIFICATION: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30",
    RESOLVED: "bg-green-500/15 text-green-300 ring-1 ring-green-500/30",
    VERIFIED: "bg-green-500/15 text-green-300 ring-1 ring-green-500/30",
    CLOSED: "bg-slate-600/15 text-slate-400 ring-1 ring-slate-600/30",
  };
  return <span className={`badge ${map[status]}`}>{status.replace(/_/g, " ")}</span>;
}

export function SlaIndicator({ risk, ageDays }: { risk: SlaRisk; ageDays: number }) {
  if (risk === "breach") {
    return (
      <span className="badge bg-red-600/15 text-red-400 ring-1 ring-red-600/40">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse-glow" />
        SLA breach · {ageDays}d
      </span>
    );
  }
  if (risk === "warn") {
    return (
      <span className="badge bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
        At risk · {ageDays}d
      </span>
    );
  }
  return (
    <span className="badge bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
      On track · {ageDays}d
    </span>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: "high" | "medium" | "low" }) {
  const map = {
    high: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30",
    medium: "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30",
    low: "bg-red-500/15 text-red-400 ring-1 ring-red-500/30",
  };
  return (
    <span className={`badge uppercase tracking-wide ${map[confidence]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${confidence === "high" ? "bg-emerald-500" : confidence === "medium" ? "bg-amber-400" : "bg-red-500"}`} />
      {confidence} confidence
    </span>
  );
}
