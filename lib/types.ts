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
  bugzillaComment: string;       // full final comment that will be posted
}

export interface TriageSubmission {
  comment: string;
  isPrivate: boolean;
  transitionTo?: TicketStatus;
  resolution?: string;
  approverNotes?: string;
  /** True when the comment was authored by a human in the manual-triage
   *  flow. When set, the submit path skips the "Analyzed by Claude:"
   *  prefix and skips appending the "Analyzed by Claude" cf_label — both
   *  belong to AI-authored comments only. */
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
