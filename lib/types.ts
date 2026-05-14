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
}

export const TICKET_STATUSES: readonly TicketStatus[] = [
  "NEW", "IN_PROGRESS", "IN_ANALYSIS", "WAITING_FOR_INFO",
  "ANALYZED", "INTEGRATED", "IN_VERIFICATION",
  "RESOLVED", "VERIFIED", "CLOSED",
];

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
