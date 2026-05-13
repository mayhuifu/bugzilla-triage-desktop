"use client";

import { Search, Filter } from "lucide-react";

export interface FilterState {
  q: string;
  severity: string;
  status: string;
  component: string;
}

export function TicketFilters({
  state,
  onChange,
  componentOptions,
}: {
  state: FilterState;
  onChange: (s: FilterState) => void;
  componentOptions: string[];
}) {
  return (
    <div className="card p-3 flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[240px]">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input
          className="input pl-9"
          placeholder="Search by ID, summary, assignee, component…"
          value={state.q}
          onChange={e => onChange({ ...state, q: e.target.value })}
        />
      </div>

      <Filter className="w-4 h-4 text-slate-500 ml-1" />

      <select
        className="input w-auto"
        value={state.severity}
        onChange={e => onChange({ ...state, severity: e.target.value })}
      >
        <option value="">All severities</option>
        <option value="Blocker">Blocker</option>
        <option value="Critical">Critical</option>
        <option value="Major">Major</option>
        <option value="Normal">Normal</option>
        <option value="Minor">Minor</option>
      </select>

      <select
        className="input w-auto"
        value={state.status}
        onChange={e => onChange({ ...state, status: e.target.value })}
      >
        <option value="">All statuses</option>
        <option value="NEW">NEW</option>
        <option value="IN_PROGRESS">IN_PROGRESS</option>
        <option value="IN_ANALYSIS">IN_ANALYSIS</option>
        <option value="WAITING_FOR_INFO">WAITING_FOR_INFO</option>
        <option value="ANALYZED">ANALYZED</option>
        <option value="IN_VERIFICATION">IN_VERIFICATION</option>
      </select>

      <select
        className="input w-auto"
        value={state.component}
        onChange={e => onChange({ ...state, component: e.target.value })}
      >
        <option value="">All components</option>
        {componentOptions.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
    </div>
  );
}
