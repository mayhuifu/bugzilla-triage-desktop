// lib/assistant/tools.ts — the toolset the Ask Zilla agent can call.
//
// READ tools execute immediately (server-side, during the agent loop) and feed
// their result back to the model. WRITE tools NEVER execute here — they return
// a structured *proposal* that the UI renders as an approval card; only when the
// user approves does the panel POST it to the existing (audited) endpoints
// (/api/tickets/[id]/submit, /api/tickets). This keeps the "AI proposes, human
// approves" contract that the rest of the app already enforces.
import "server-only";
import { bridgeSearch, bridgeFetch, bridgeStats, bridgeWhoami } from "@/lib/bridge";
import { mockSearch, buildMockStats, buildMockDetail } from "@/lib/mock-data";
import { retrieveByText } from "@/lib/corpus/retriever";
import type { InvolveRole } from "@/lib/bugzilla";
import { OPEN_STATUSES, CLOSED_STATUSES, type TicketSummary, type TicketStatus } from "@/lib/types";

export type ToolKind = "read" | "write";

/** A write the agent wants to make. The UI previews it and, on approval, calls
 *  `endpoint` with `body`. Maps onto existing audited routes — no new write path. */
export interface AgentProposal {
  kind: "comment" | "status" | "file_ticket";
  title: string;                       // one-line preview, e.g. "Comment on #16523"
  detail: string;                      // the human-readable body to show in the card
  endpoint: string;                    // existing route to call on approval
  method: "POST";
  body: Record<string, unknown>;
}

export interface ToolResult {
  summary: string;                     // fed back to the model
  tickets?: TicketSummary[];           // surfaced to the UI (drives the dashboard table)
  proposal?: AgentProposal;            // write tools only
}

export interface AgentTool {
  name: string;
  kind: ToolKind;
  description: string;                 // shown to the model in the system prompt
  args: string;                        // arg schema, shown to the model
}

// ── catalog (also the source for the system-prompt tool list) ──────
export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "search_tickets",
    kind: "read",
    description: "Find Bugzilla tickets by structured filters. Use this for any 'show/find/list/how many … tickets' request. Returns a ticket list that also populates the dashboard table.",
    args: '{ product?: string, component?: string, severity?: "Blocker"|"Critical"|"Major"|"Normal"|"Minor" (or array), statusGroup?: "open"|"closed"|"any", status?: string, filedMoreThanDaysAgo?: number, filedWithinDays?: number, notUpdatedInDays?: number, updatedWithinDays?: number, mine?: boolean, roles?: ("assignee"|"reporter"|"cc")[], text?: string, sort?: "newest"|"oldest"|"stalest", limit?: number }',
  },
  {
    name: "get_ticket",
    kind: "read",
    description: "Fetch one ticket's full detail (description, comments, status) by id.",
    args: "{ id: number }",
  },
  {
    name: "get_stats",
    kind: "read",
    description: "Aggregate counts (open/closed/blocker/critical totals + 7-day trend) for a product/component scope.",
    args: "{ product?: string, component?: string }",
  },
  {
    name: "search_specs",
    kind: "read",
    description: "Search the bundled 3GPP spec corpus (NR + LTE) for clauses relevant to a query. Use for '3GPP/spec/standard says…' questions.",
    args: "{ query: string, limit?: number }",
  },
  {
    name: "propose_comment",
    kind: "write",
    description: "Propose posting a comment on a ticket. Does NOT post — the user must approve.",
    args: "{ id: number, comment: string }",
  },
  {
    name: "propose_status_change",
    kind: "write",
    description: "Propose changing a ticket's status (with a short comment). Does NOT change — the user must approve.",
    args: '{ id: number, status: string, resolution?: string, comment?: string }',
  },
  {
    name: "propose_file_ticket",
    kind: "write",
    description: "Propose filing a new ticket. Does NOT file — the user must approve.",
    args: "{ product: string, component: string, summary: string, description: string, severity?: string, type?: string }",
  },
];

// ── helpers ────────────────────────────────────────────────────────
const dayMs = 86_400_000;
const cutoffMs = (daysAgo: number) => Date.now() - daysAgo * dayMs;

function asArray<T>(v: T | T[] | undefined): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

// ── read-tool execution ────────────────────────────────────────────
export async function executeReadTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case "search_tickets":  return searchTickets(args);
    case "get_ticket":      return getTicket(args);
    case "get_stats":       return getStats(args);
    case "search_specs":    return searchSpecs(args);
    default: throw new Error(`unknown read tool: ${name}`);
  }
}

async function searchTickets(a: Record<string, unknown>): Promise<ToolResult> {
  const statusGroup = (a.statusGroup as string) || (a.status ? "" : "any");
  const statuses: string[] =
    a.status ? [String(a.status)] :
    statusGroup === "open" ? [...OPEN_STATUSES] :
    statusGroup === "closed" ? [...CLOSED_STATUSES] : [];
  const severity = asArray(a.severity as string | string[]);
  const text = a.text as string | undefined;

  let involves: string | undefined;
  let involveRoles: InvolveRole[] | undefined;
  if (a.mine) {
    try { involves = (await bridgeWhoami()).login || undefined; } catch { /* leave unset */ }
    involveRoles = (asArray(a.roles as InvolveRole | InvolveRole[]).length
      ? asArray(a.roles as InvolveRole | InvolveRole[]) : ["assignee"]) as InvolveRole[];
  }

  // Fetch a wide pool by the structured filters, then apply ALL date logic
  // client-side (Bugzilla's REST date params are lower-bound only, and this also
  // works uniformly on the mock fallback). Degrades to mock data when Bugzilla
  // is unreachable — same contract as the dashboard's /api/tickets route.
  let pool: TicketSummary[];
  let demo = false;
  try {
    pool = (await bridgeSearch({
      product: a.product as string | undefined,
      component: a.component as string | undefined,
      severity, status: statuses, involves, involveRoles,
      quicksearch: text, limit: 500,
    })).tickets;
  } catch {
    demo = true;
    pool = mockSearch({
      product: a.product as string | undefined,
      component: a.component as string | undefined,
      severity, status: statuses, involves, involveRoles, q: text, limit: 500,
    }).tickets;
  }

  // Relative-day filters → created/changed windows (both bounds, client-side).
  const created = (t: TicketSummary) => new Date(t.creationTime).getTime();
  const changed = (t: TicketSummary) => new Date(t.lastChangeTime).getTime();
  const filedBefore = a.filedMoreThanDaysAgo != null ? cutoffMs(Number(a.filedMoreThanDaysAgo)) : null;
  const filedAfter  = a.filedWithinDays     != null ? cutoffMs(Number(a.filedWithinDays))     : null;
  const staleBefore = a.notUpdatedInDays    != null ? cutoffMs(Number(a.notUpdatedInDays))    : null;
  const updatedAfter = a.updatedWithinDays  != null ? cutoffMs(Number(a.updatedWithinDays))   : null;
  let rows = pool.filter(t =>
    (filedBefore == null || created(t) <= filedBefore) &&
    (filedAfter  == null || created(t) >= filedAfter) &&
    (staleBefore == null || changed(t) <= staleBefore) &&
    (updatedAfter == null || changed(t) >= updatedAfter));

  const sort = (a.sort as string) || "newest";
  if (sort === "oldest") rows.sort((x, y) => created(x) - created(y));
  else if (sort === "stalest") rows.sort((x, y) => changed(x) - changed(y));
  else rows.sort((x, y) => changed(y) - changed(x)); // newest activity first

  const limit = Math.max(1, Math.min(Number(a.limit) || 50, 200));
  const total = rows.length;
  rows = rows.slice(0, limit);

  const lines = rows.slice(0, 25).map(t =>
    `#${t.id} [${t.severity}/${t.status}] ${t.summary.slice(0, 80)} — assignee ${t.assignee}, filed ${t.creationTime.slice(0, 10)}, last update ${t.lastChangeTime.slice(0, 10)}`);
  const prefix = demo ? "(Demo data — Bugzilla unreachable) " : "";
  const summary = total === 0
    ? `${prefix}No tickets matched.`
    : `${prefix}Matched ${total} ticket(s)${total > limit ? ` (showing ${limit})` : ""}. The dashboard table now shows them.\n${lines.join("\n")}${total > 25 ? `\n…and ${total - 25} more.` : ""}`;
  return { summary, tickets: rows };
}

async function getTicket(a: Record<string, unknown>): Promise<ToolResult> {
  const id = Number(a.id);
  if (!id) return { summary: "get_ticket needs a numeric id." };
  let ticket;
  try { ticket = (await bridgeFetch(id)).ticket; }
  catch {
    try { ticket = buildMockDetail(id); }
    catch { return { summary: `Couldn't fetch #${id} — Bugzilla is unreachable and it's not in the demo set.` }; }
  }
  const comments = ticket.comments.slice(0, 6).map(c => `- ${c.author} (${c.time.slice(0, 10)}): ${c.text.slice(0, 300)}`).join("\n");
  const summary = `#${ticket.id} [${ticket.severity}/${ticket.status}] ${ticket.summary}\nProduct ${ticket.product} / ${ticket.component}, assignee ${ticket.assignee}, reporter ${ticket.reporter}\nFiled ${ticket.creationTime.slice(0, 10)}, last update ${ticket.lastChangeTime.slice(0, 10)}\n\nDescription:\n${ticket.description.slice(0, 1500)}\n\nRecent comments:\n${comments}`;
  return { summary };
}

async function getStats(a: Record<string, unknown>): Promise<ToolResult> {
  const scope = { product: a.product as string | undefined, component: a.component as string | undefined };
  let stats; let demo = false;
  try { stats = await bridgeStats(scope, "all"); }
  catch { stats = buildMockStats(scope); demo = true; }
  return { summary: `${demo ? "(Demo data — Bugzilla unreachable) " : ""}Stats for ${a.product ?? "all products"}${a.component ? "/" + a.component : ""}:\n${JSON.stringify(stats, null, 2).slice(0, 1500)}` };
}

async function searchSpecs(a: Record<string, unknown>): Promise<ToolResult> {
  const q = String(a.query || "").trim();
  if (!q) return { summary: "search_specs needs a query." };
  const hits = await retrieveByText(q, { limit: Math.max(1, Math.min(Number(a.limit) || 4, 10)) });
  if (!hits.length) return { summary: `No spec clauses found for "${q}" (corpus may not be installed).` };
  const body = hits.map(h => `${h.citation} — ${h.title}\n${h.text.slice(0, 600)}`).join("\n\n");
  return { summary: `3GPP clauses for "${q}":\n\n${body}` };
}

// ── write-tool proposal building (no execution) ────────────────────
export function buildProposal(name: string, a: Record<string, unknown>): AgentProposal {
  switch (name) {
    case "propose_comment": {
      const id = Number(a.id);
      const comment = String(a.comment || "").trim();
      if (!id || !comment) throw new Error("propose_comment needs id + comment");
      return {
        kind: "comment", title: `Comment on #${id}`, detail: comment,
        endpoint: `/api/tickets/${id}/submit`, method: "POST",
        body: { comment, manual: true },
      };
    }
    case "propose_status_change": {
      const id = Number(a.id);
      const status = String(a.status || "").trim();
      if (!id || !status) throw new Error("propose_status_change needs id + status");
      const comment = String(a.comment || `Status changed to ${status} via Ask Zilla.`);
      return {
        kind: "status", title: `Set #${id} → ${status}`,
        detail: `${comment}${a.resolution ? `\nResolution: ${a.resolution}` : ""}`,
        endpoint: `/api/tickets/${id}/submit`, method: "POST",
        body: { comment, transitionTo: status as TicketStatus, resolution: a.resolution as string | undefined, manual: true },
      };
    }
    case "propose_file_ticket": {
      const { product, component, summary, description } = a as Record<string, string>;
      if (!product || !component || !summary || !description) throw new Error("propose_file_ticket needs product, component, summary, description");
      return {
        kind: "file_ticket", title: `File ticket in ${product}/${component}`,
        detail: `${summary}\n\n${description}`,
        endpoint: `/api/tickets`, method: "POST",
        body: { product, component, summary, description, severity: a.severity, type: a.type },
      };
    }
    default: throw new Error(`unknown write tool: ${name}`);
  }
}

export function isWriteTool(name: string): boolean {
  return AGENT_TOOLS.some(t => t.name === name && t.kind === "write");
}
export function isKnownTool(name: string): boolean {
  return AGENT_TOOLS.some(t => t.name === name);
}
