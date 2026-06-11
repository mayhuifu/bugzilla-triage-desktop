// ─────────────────────────────────────────────────────────────────
// Shared types for the Bugzilla AI Triage Dashboard
// ─────────────────────────────────────────────────────────────────

export type Severity = "Blocker" | "Critical" | "Major" | "Normal" | "Minor" | "Trivial" | "Enhancement";

export type TicketStatus =
  | "NEW"
  | "IN_PROGRESS"
  | "IN_ANALYSIS"
  | "WAITING_FOR_INFO"
  | "ANALYZED"
  | "INTEGRATED"
  | "IN_VERIFICATION"
  | "RESOLVED"
  | "VERIFIED"
  | "CLOSED";

export type SlaRisk = "ok" | "warn" | "breach";

export interface TicketSummary {
  id: number;
  summary: string;
  product: string;
  component: string;
  customer?: string;
  severity: Severity;
  priority: string;
  status: TicketStatus;
  resolution?: string;
  assignee: string;
  reporter: string;
  creationTime: string;     // ISO
  lastChangeTime: string;   // ISO
  ageDays: number;
  daysSinceUpdate: number;
  slaRisk: SlaRisk;
  /** Bugzilla's `deadline` field — YYYY-MM-DD when the bug has an explicit
   *  due date, undefined otherwise. When set, this overrides the
   *  default age-based SLA: past = breach, ≤ 5 days out = warn,
   *  > 5 days out = ok. Carried in TicketSummary so the SLA badge can
   *  display "N days overdue" / "due in N days" instead of the default
   *  age-based wording. See lib/bugzilla.ts → computeSla. */
  dueDate?: string;
  label?: string;
  keywords?: string[];
}

export interface TicketComment {
  id: number;
  count: number;
  author: string;
  time: string;
  text: string;
  isPrivate: boolean;
}

export interface TicketHistoryChange {
  field: string;
  removed: string;
  added: string;
}

export interface TicketHistoryEntry {
  who: string;
  when: string;
  changes: TicketHistoryChange[];
}

export interface TicketAttachment {
  id: number;
  fileName: string;
  contentType: string;
  size: number;
  creator: string;
  creationTime: string;
}

export interface TicketDetail extends TicketSummary {
  description: string;
  cc: string[];
  blocks: number[];
  dependsOn: number[];
  whiteboard?: string;
  url?: string;
  comments: TicketComment[];
  history: TicketHistoryEntry[];
  attachments: TicketAttachment[];
}

// ─────────────────────────────────────────────────────────────────
// AI Triage shapes — structured editable fields
// ─────────────────────────────────────────────────────────────────

export interface TriageResult {
  ticketId: number;
  generatedAt: string;
  model: string;
  confidence: "high" | "medium" | "low";
  domain: string;                       // e.g. "NR RF · AT-command surface · band n40"
  specReferences: string[];             // 3GPP clauses applicable
  /** Optional reference summaries for each entry in `specReferences`.
   *  Added in v0.1.5 so the Bugzilla comment's CLASSIFICATION header can
   *  give a debugger a short paraphrase of what each cited clause says
   *  (drawn from the model's training data). One entry per clause when
   *  the model knows it; missing entries fall back to clause-only. */
  specExcerpts: SpecExcerpt[];
  issueSummary: string;
  rootCauses: Array<{
    rank: number;
    label: string;
    rationale: string;
    likelihood: "high" | "medium" | "low";
  }>;
  missingInformation: string[];
  nextSteps: Array<{
    owner: string;
    action: string;
    passFail: string;
  }>;
  escalationRecommendation: string;
  internalSummary: string;       // engineer-facing
  customerSummary: string;       // customer-safe (sanitized)
  /** The full Bugzilla comment body. As of v0.1.5 this is pre-merged
   *  server-side to start with a CLASSIFICATION section built from
   *  `confidence` / `domain` / `specReferences` / `specExcerpts`, followed
   *  by the model's 4-layer body (OBSERVED / INFERRED / HYPOTHESIS /
   *  NEXT STEPS). Editable in the UI before submission. */
  bugzillaComment: string;
}

export interface SpecExcerpt {
  /** The clause being summarized, matching one of the strings in
   *  `TriageResult.specReferences`, e.g. "3GPP TS 38.211 §6.1.4". */
  clause: string;
  /** Brief 1–3 sentence paraphrase of what this clause specifies, drawn
   *  from the model's knowledge. Editable in the UI; the user can refine
   *  before submission. */
  summary: string;

  // ── v0.1.6 additions — populated server-side when the 3GPP RAG
  // corpus is installed and the clause is found. All optional so the
  // schema stays backwards-compatible with v0.1.5 settings and with
  // the model's raw output (which only fills `clause` + `summary`).

  /** Canonical id used by the corpus retriever, e.g. "38.211#6.1.4".
   *  Set when the clause was matched in the corpus; null/undefined
   *  when the corpus isn't installed or the citation didn't parse. */
  clauseId?: string;
  /** The clause's own title from the spec, e.g. "Generation of reference signal". */
  title?: string;
  /** Title of the immediate parent section, e.g. "Physical channel processing".
   *  Used by the side-drawer (M3) to render breadcrumb context. */
  parentTitle?: string;
  /** The actual clause text from the 3GPP corpus. The renderClassification-
   *  Header function prefers the first 2 sentences of this over `summary`
   *  when present. Editable in the UI like `summary`. */
  realText?: string;
  /** Where the excerpt came from:
   *  - "model"        — paraphrase only; corpus not consulted or clause missing
   *  - "corpus"       — both summary and realText set; UI shows realText
   *  - "corpus+model" — model paraphrase + corpus realText both available */
  source?: "model" | "corpus" | "corpus+model";
  /** Reason a corpus match wasn't produced (only set when source === "model"
   *  and a corpus is installed). Lets the UI explain WHY the View clause
   *  button is missing instead of users guessing:
   *   - "spec_not_curated" — the cited spec (e.g. TS 38.304) isn't in the
   *                          curated rel17-vN set at all. Not a bug; coverage gap.
   *   - "clause_not_found" — the spec IS in the corpus but the cited clause
   *                          number doesn't match any leaf, even via the
   *                          ancestor-prefix fallback. Either the model
   *                          cited an obsolete / re-numbered clause, or
   *                          the corpus parser dropped it.
   *   - "no_corpus"        — corpus isn't installed at all (rare; the UI's
   *                          RAG toggle is usually gated to hide in this case).
   */
  lookupReason?: "spec_not_curated" | "clause_not_found" | "no_corpus";
}

export interface TriageSubmission {
  comment: string;
  isPrivate: boolean;
  transitionTo?: TicketStatus;
  resolution?: string;
  approverNotes?: string;
  /** True when the comment was authored by a human in the manual-triage
   *  flow. When set, the submit path skips the "Analyzed by AI Triage Bot:"
   *  prefix and skips appending the "Analyzed by AI Triage Bot" cf_label —
   *  both belong to AI-authored comments only. */
  manual?: boolean;
}

export const TICKET_STATUSES: readonly TicketStatus[] = [
  "NEW", "IN_PROGRESS", "IN_ANALYSIS", "WAITING_FOR_INFO",
  "ANALYZED", "INTEGRATED", "IN_VERIFICATION",
  "RESOLVED", "VERIFIED", "CLOSED",
];

// Canonical open/closed partition. Keep in sync with the same sets in
// scripts/bz_bridge.py (OPEN_STATUSES / CLOSED_STATUSES).
export const CLOSED_STATUSES: readonly TicketStatus[] = ["RESOLVED", "VERIFIED", "CLOSED"];
export const OPEN_STATUSES: readonly TicketStatus[] =
  TICKET_STATUSES.filter(s => !(CLOSED_STATUSES as readonly string[]).includes(s));

// Clicking a card in the ProductStatus or TrendBar grid sets one of these
// buckets. The bucket drives the server-side ticket search (status,
// severity, and date windows), overriding the dropdown selections.
export type TicketBucket =
  // Snapshot (status × severity) — top row
  | "open" | "open-blocker" | "open-critical"
  | "closed" | "closed-blocker" | "closed-critical"
  // Last-7-day trends — bottom row
  | "last7d-filed" | "last7d-filed-bc"
  | "last7d-closed" | "last7d-closed-bc";

export const BUCKET_LABELS: Record<TicketBucket, string> = {
  "open": "Open tickets",
  "open-blocker": "Open · Blocker",
  "open-critical": "Open · Critical",
  "closed": "Closed tickets",
  "closed-blocker": "Closed · Blocker",
  "closed-critical": "Closed · Critical",
  "last7d-filed": "Filed in last 7 days",
  "last7d-filed-bc": "Filed in last 7 days · B+C",
  "last7d-closed": "Closed in last 7 days",
  "last7d-closed-bc": "Closed in last 7 days · B+C",
};

// ─────────────────────────────────────────────────────────────────
// Dashboard filter helpers (products, whoami, stats)
// ─────────────────────────────────────────────────────────────────

export interface ProductInfo {
  name: string;
  components: string[];
  /** Active version values for this product — needed when FILING a ticket
   *  (Bugzilla's POST /rest/bug requires `version`). The create form falls
   *  back to "unspecified" when empty. */
  versions: string[];
}

export interface WhoAmI {
  login: string;
  realName: string;
  id: number | null;
  source: "whoami" | "env-fallback";
}

export interface TrendBucket {
  filed: number;
  filedBC: number;   // Blocker + Critical
  closed: number;
  closedBC: number;
}

export interface DashboardStats {
  scope: { product: string | null; component: string | null; assignee: string | null };
  open: { total: number; blocker: number; critical: number };
  closed: { total: number; blocker: number; critical: number };
  trend: {
    last7d: TrendBucket;
    prev7d: TrendBucket;
    netFlowPerWeek: number;  // filed - closed for last 7d; positive = backlog growing
  };
  generatedAt: string;
}

export interface SubmissionReceipt {
  success: boolean;
  ticketId: number;
  commentId?: number;
  newStatus?: TicketStatus;
  postedAt: string;
  message: string;
}
