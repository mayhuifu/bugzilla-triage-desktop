"use client";

import { Search, Filter, User, FilePlus2, Sparkles } from "lucide-react";
import type { ProductInfo, WhoAmI } from "@/lib/types";
import { AssigneeFilter } from "./AssigneeFilter";

/** Which roles "My Tickets" counts as "mine". Default: assignee only. */
export interface MyRoles {
  assignee: boolean;
  reporter: boolean;
  cc: boolean;
}

export interface FilterState {
  q: string;
  product: string;     // "" = all products
  component: string;   // "" = all components
  assignee: string;    // "" = all assignees; full email — e.g. "joachim.wehinger@umsemi.com"
  severity: string;
  status: string;
  myTickets: boolean;
  myRoles: MyRoles;
}

const ROLE_OPTIONS: { key: keyof MyRoles; label: string }[] = [
  { key: "assignee", label: "Assignee" },
  { key: "reporter", label: "Reporter" },
  { key: "cc", label: "CC" },
];

export function TicketFilters({
  state,
  onChange,
  products,
  componentOptions,
  assigneeOptions,
  whoami,
  bucketActive = false,
  onFileTicket,
  onAsk,
}: {
  state: FilterState;
  onChange: (s: FilterState) => void;
  products: ProductInfo[];
  // Components observed in the *currently loaded* ticket list. Used as a
  // fallback when no product is selected (so the dropdown still has options
  // before the products endpoint resolves).
  componentOptions: string[];
  // Assignees observed in the *currently loaded* ticket list, alphabetized.
  // Like componentOptions, this narrows as filters are applied — picking
  // a product or component shrinks the assignee list to engineers visible
  // in that scope. Empty array → dropdown is disabled.
  assigneeOptions: string[];
  whoami: WhoAmI | null;
  // When the user has clicked a status card, the bucket filter overrides
  // these dropdowns server-side. We disable them visually so the user
  // doesn't think they can stack.
  bucketActive?: boolean;
  /** Opens the File-a-Ticket dialog (button next to My Tickets). */
  onFileTicket?: () => void;
  /** Opens the Ask Zilla agent panel. */
  onAsk?: () => void;
}) {
  // Component options come from the selected product when available — that
  // way picking a product narrows the list to its real components rather
  // than whatever happens to be in the loaded page of tickets.
  const componentsForProduct = state.product
    ? products.find(p => p.name === state.product)?.components ?? []
    : componentOptions;

  // When My Tickets is on, the assignee param is already set to whoami.login
  // server-side — the assignee dropdown would be a no-op (or worse, conflict).
  // Disable it visually so the user knows the two are mutually exclusive.
  const assigneeDisabled = state.myTickets;

  return (
    <div className="card p-3 flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[240px]">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input
          className="input pl-9"
          // Numeric → direct ticket-ID fetch (pins outside current scope).
          // Non-numeric ≥ 2 chars → debounced Bugzilla quicksearch
          // (searches summary, assignee, component, comments, description).
          // 1-char → client-side narrowing of the loaded page only.
          placeholder="Type a ticket #, name, component, or phrase — searches Bugzilla server-side"
          value={state.q}
          onChange={e => onChange({ ...state, q: e.target.value })}
        />
      </div>

      <Filter className="w-4 h-4 text-slate-500 ml-1" />

      <select
        className="input w-auto"
        value={state.product}
        // Reset component when product changes so we don't keep a stale
        // component name that doesn't exist under the new product.
        onChange={e => onChange({ ...state, product: e.target.value, component: "" })}
        title="Product"
      >
        <option value="">All products</option>
        {products.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
      </select>

      <select
        className="input w-auto"
        value={state.component}
        onChange={e => onChange({ ...state, component: e.target.value })}
        title="Component"
        disabled={!componentsForProduct.length}
      >
        <option value="">All components</option>
        {componentsForProduct.map(c => <option key={c} value={c}>{c}</option>)}
      </select>

      <AssigneeFilter
        value={state.assignee}
        onChange={email => onChange({ ...state, assignee: email })}
        // Loaded-ticket assignees serve as instant suggestions while
        // the input is empty + focused. Typing >=2 chars triggers a
        // live Bugzilla /rest/user search and replaces them.
        recentSuggestions={assigneeOptions}
        disabled={assigneeDisabled}
        disabledReason="Cleared by My Tickets — turn that off to pick a different assignee"
      />

      <select
        className="input w-auto disabled:opacity-40"
        value={state.severity}
        onChange={e => onChange({ ...state, severity: e.target.value })}
        disabled={bucketActive}
        title={bucketActive ? "Cleared by status-card filter" : undefined}
      >
        <option value="">All severities</option>
        <option value="Blocker">Blocker</option>
        <option value="Critical">Critical</option>
        <option value="Major">Major</option>
        <option value="Normal">Normal</option>
        <option value="Minor">Minor</option>
      </select>

      <select
        className="input w-auto disabled:opacity-40"
        value={state.status}
        onChange={e => onChange({ ...state, status: e.target.value })}
        disabled={bucketActive}
        title={bucketActive ? "Cleared by status-card filter" : undefined}
      >
        <option value="">All statuses</option>
        <option value="NEW">NEW</option>
        <option value="IN_PROGRESS">IN_PROGRESS</option>
        <option value="IN_ANALYSIS">IN_ANALYSIS</option>
        <option value="WAITING_FOR_INFO">WAITING_FOR_INFO</option>
        <option value="ANALYZED">ANALYZED</option>
        <option value="IN_VERIFICATION">IN_VERIFICATION</option>
      </select>

      <button
        onClick={() => onChange({ ...state, myTickets: !state.myTickets })}
        disabled={!whoami?.login}
        title={whoami?.login ? `Tickets you filed, are assigned, or are CC'd on (${whoami.login})` : "Sign-in not detected"}
        className={`input w-auto flex items-center gap-1.5 text-xs disabled:opacity-50 ${
          state.myTickets
            ? "ring-2 ring-accent text-accent-glow"
            : "text-slate-300"
        }`}
      >
        <User className="w-3.5 h-3.5" />
        My Tickets
      </button>

      {state.myTickets && (
        <div className="flex items-center gap-1 text-[11px] text-slate-400" title="Which roles count as 'mine'">
          <span className="text-slate-500">as</span>
          {ROLE_OPTIONS.map(({ key, label }) => {
            const on = state.myRoles[key];
            return (
              <button
                key={key}
                onClick={() => {
                  const next = { ...state.myRoles, [key]: !on };
                  // Never leave all roles off — fall back to assignee.
                  if (!next.assignee && !next.reporter && !next.cc) next.assignee = true;
                  onChange({ ...state, myRoles: next });
                }}
                title={`Include tickets where you are the ${label.toLowerCase()}`}
                className={`px-2 py-1 rounded ring-1 transition-colors ${
                  on
                    ? "ring-accent/50 bg-accent/10 text-accent-glow"
                    : "ring-bg-border/50 text-slate-500 hover:text-slate-300"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {onFileTicket && (
        <button
          onClick={onFileTicket}
          title="File a new ticket in Bugzilla — you'll be the reporter"
          className="input w-auto flex items-center gap-1.5 text-xs text-accent-glow ring-1 ring-accent/40 hover:bg-accent/10"
        >
          <FilePlus2 className="w-3.5 h-3.5" />
          File a Ticket
        </button>
      )}

      {onAsk && (
        <button
          onClick={onAsk}
          title="Ask in plain English — search tickets, query 3GPP specs, draft actions"
          className="input w-auto flex items-center gap-1.5 text-xs text-white bg-gradient-to-r from-accent to-fuchsia-600 hover:opacity-90 ring-0"
        >
          <Sparkles className="w-3.5 h-3.5" />
          Ask Zilla
        </button>
      )}
    </div>
  );
}
