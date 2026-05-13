"use client";

import Link from "next/link";
import { ArrowLeft, ExternalLink, User, Clock, Tag } from "lucide-react";
import type { TicketDetail } from "@/lib/types";
import { SeverityBadge, StatusBadge, SlaIndicator } from "@/components/ui/Badge";

export function TicketDetailHeader({ ticket }: { ticket: TicketDetail }) {
  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2 min-w-0 flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <Link href="/" className="btn-ghost text-xs py-1 px-2">
              <ArrowLeft className="w-3.5 h-3.5" />
              Dashboard
            </Link>
            <div className="font-mono text-slate-500 text-sm">#{ticket.id}</div>
            <SeverityBadge severity={ticket.severity} />
            <StatusBadge status={ticket.status} />
            <SlaIndicator risk={ticket.slaRisk} ageDays={ticket.ageDays} />
            {ticket.label && (
              <span className="badge bg-fuchsia-500/10 text-fuchsia-300 ring-1 ring-fuchsia-500/30">
                <Tag className="w-3 h-3" />
                {ticket.label}
              </span>
            )}
          </div>
          <h1 className="text-xl font-semibold text-slate-100 leading-tight">{ticket.summary}</h1>
        </div>
        {ticket.url && (
          <a
            href={ticket.url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary text-xs py-1.5 px-3 shrink-0"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open in Bugzilla
          </a>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <Meta label="Product / Component" value={`${ticket.product} / ${ticket.component}`} />
        <Meta label="Priority" value={ticket.priority} />
        <Meta label="Assignee" value={ticket.assignee.split("@")[0]} icon={User} />
        <Meta label="Reporter" value={ticket.reporter.split("@")[0]} icon={User} />
        <Meta label="Created" value={new Date(ticket.creationTime).toLocaleString()} icon={Clock} />
        <Meta label="Last update" value={`${ticket.daysSinceUpdate}d ago`} icon={Clock} />
        {ticket.customer && <Meta label="Customer / Site" value={ticket.customer} />}
        {ticket.keywords?.length ? <Meta label="Keywords" value={ticket.keywords.join(", ")} /> : null}
      </div>

      {ticket.cc.length > 0 && (
        <div className="text-xs">
          <span className="text-slate-500">CC:&nbsp;</span>
          <span className="text-slate-300">{ticket.cc.map(c => c.split("@")[0]).join(", ")}</span>
        </div>
      )}
    </div>
  );
}

function Meta({ label, value, icon: Icon }: { label: string; value: string; icon?: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 flex items-center gap-1">
        {Icon && <Icon className="w-3 h-3" />}
        {label}
      </div>
      <div className="text-sm text-slate-200">{value}</div>
    </div>
  );
}
