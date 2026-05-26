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

/** Days until a YYYY-MM-DD date. Positive = future, negative = past, null
 *  for missing/unparseable input. Matches the server-side helper in
 *  lib/bugzilla.ts — defined here too so the badge stays a pure render
 *  component (no extra prop wiring needed). */
function daysUntilIsoUI(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso + "T23:59:59Z").getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

export function SlaIndicator({
  risk,
  ageDays,
  dueDate,
}: {
  risk: SlaRisk;
  ageDays: number;
  /** Optional Bugzilla `deadline` (YYYY-MM-DD). When present, the badge
   *  labels the suffix as "Nd overdue" / "due in Nd" so the user
   *  immediately sees this ticket has an explicit deadline driving the
   *  SLA. When absent, falls back to the default age-based wording. */
  dueDate?: string;
}) {
  const daysUntilDue = daysUntilIsoUI(dueDate);
  const driverIsDueDate = daysUntilDue != null;

  if (risk === "breach") {
    const suffix = driverIsDueDate
      ? `${Math.max(1, -daysUntilDue!)}d overdue`
      : `${ageDays}d`;
    return (
      <span
        className="badge bg-red-600/15 text-red-400 ring-1 ring-red-600/40"
        title={
          driverIsDueDate
            ? `Due date ${dueDate} — past`
            : `Open ${ageDays}d (default SLA — Blocker/Critical breach after 30d)`
        }
      >
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse-glow" />
        SLA breach · {suffix}
      </span>
    );
  }
  if (risk === "warn") {
    const suffix = driverIsDueDate
      ? daysUntilDue! === 0
        ? "due today"
        : `due in ${daysUntilDue!}d`
      : `${ageDays}d`;
    return (
      <span
        className="badge bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30"
        title={
          driverIsDueDate
            ? `Due date ${dueDate} — within 5 days`
            : `Open ${ageDays}d (default SLA — approaching breach threshold)`
        }
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
        At risk · {suffix}
      </span>
    );
  }
  const suffix = driverIsDueDate
    ? `due in ${daysUntilDue!}d`
    : `${ageDays}d`;
  return (
    <span
      className="badge bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20"
      title={
        driverIsDueDate
          ? `Due date ${dueDate} — comfortably ahead`
          : `Open ${ageDays}d (within default SLA window)`
      }
    >
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
      On track · {suffix}
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
