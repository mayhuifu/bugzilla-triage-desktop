// ─────────────────────────────────────────────────────────────────
// Bugzilla REST client — pure TypeScript.
//
// Replaces scripts/bz_bridge.py for everything except the AI triage step.
// The motivation is to drop the Python + uv + bugzilla-mcp clone runtime
// dependencies so the dashboard can ship as a standalone Windows app
// (Electron, milestone 4) where non-technical users can't be expected
// to install Python.
//
// Server-side only — uses node:fetch via undici and reads credentials
// from environment variables (the upcoming `/settings` page in milestone
// 3 will replace the env-var path with encrypted local storage).
// ─────────────────────────────────────────────────────────────────

import "server-only";
import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";

import type {
  TicketSummary, TicketDetail, SubmissionReceipt, TicketStatus,
  ProductInfo, WhoAmI, DashboardStats, Severity,
} from "./types";
import { OPEN_STATUSES, CLOSED_STATUSES } from "./types";

// ── Configuration ─────────────────────────────────────────────────

/** umsemi-specific conventions, previously imported from the bugzilla-mcp
 * skill module. Centralized here so we only have one place to update if
 * resolution vocabulary changes. */
export const ANALYSIS_PREFIX = "Analyzed by Claude:";
export const CLAUDE_LABEL = "Analyzed by Claude";
export const VALID_RESOLUTIONS = [
  "FIXED", "WONT_FIX", "DUPLICATE", "NOT_REPRODUCIBLE",
  "FIX_IN_OTHER_PRODUCT", "WORK_ITEM_DONE",
  "DOCUMENT_APPROVED", "DOCUMENT_READY_FOR_REVIEW", "DOCUMENT_UPDATE",
  "CONFIG_CHANGE", "SYSTEM_REQUIREMENT_APPROVED",
] as const;

interface BugzillaConfig {
  url: string;
  apiKey: string;
  insecure: boolean;
  login: string;
}

function readConfig(): BugzillaConfig {
  return {
    url: (process.env.BUGZILLA_URL || "").replace(/\/$/, ""),
    apiKey: process.env.BUGZILLA_API_KEY || "",
    insecure: (process.env.BUGZILLA_INSECURE || "true").toLowerCase() === "true",
    login: process.env.BUGZILLA_LOGIN || "",
  };
}

// ── Low-level HTTP via node:https ─────────────────────────────────
//
// We deliberately use node:https directly instead of the global fetch
// (which is undici-backed) because passing an undici Agent across the
// Next.js bundle boundary triggers a version mismatch
// ("invalid onRequestStart method"). Plain node:https has no such issue
// and gives precise control over rejectUnauthorized for self-signed
// internal Bugzilla certs.

/** Query-string params as a list-of-tuples so repeated keys (status,
 * severity) survive — URLSearchParams handles them correctly. */
type Params = ReadonlyArray<readonly [string, string]>;

function buildUrl(base: string, path: string, params: Params): string {
  const qs = new URLSearchParams();
  for (const [k, v] of params) qs.append(k, v);
  return `${base}${path}?${qs.toString()}`;
}

interface HttpRes { status: number; body: string }

function nodeRequest(
  method: "GET" | "POST" | "PUT",
  fullUrl: string,
  body: string | undefined,
  insecure: boolean,
  timeoutMs: number,
): Promise<HttpRes> {
  return new Promise((resolve, reject) => {
    const u = new URL(fullUrl);
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;
    const req = mod.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        headers: body
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
          : {},
        rejectUnauthorized: !insecure,
        timeout: timeoutMs,
      },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    if (body) req.write(body);
    req.end();
  });
}

async function bzGet(path: string, params: Params, timeoutMs = 30_000): Promise<unknown> {
  const cfg = readConfig();
  if (!cfg.url || !cfg.apiKey) {
    throw new Error("Bugzilla not configured (BUGZILLA_URL / BUGZILLA_API_KEY env vars missing)");
  }
  const url = buildUrl(cfg.url, path, [["api_key", cfg.apiKey], ...params]);

  // Retry transient TLS / connection-reset errors common on internal VPN
  // tunnels. The Python bridge had identical retry logic.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await nodeRequest("GET", url, undefined, cfg.insecure, timeoutMs);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Bugzilla GET ${path} → ${res.status}: ${res.body.slice(0, 300)}`);
      }
      return JSON.parse(res.body);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const retryable = /ECONNRESET|EPIPE|ETIMEDOUT|timeout|SSL|TLS|socket hang up|UNABLE_TO/i.test(msg);
      if (!retryable || attempt === 3) break;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function bzPost(path: string, body: unknown, timeoutMs = 30_000): Promise<unknown> {
  const cfg = readConfig();
  if (!cfg.url || !cfg.apiKey) throw new Error("Bugzilla not configured");
  const url = buildUrl(cfg.url, path, [["api_key", cfg.apiKey]]);
  const res = await nodeRequest("POST", url, JSON.stringify(body), cfg.insecure, timeoutMs);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Bugzilla POST ${path} → ${res.status}: ${res.body.slice(0, 300)}`);
  }
  return JSON.parse(res.body);
}

async function bzPut(path: string, body: unknown, timeoutMs = 30_000): Promise<unknown> {
  const cfg = readConfig();
  if (!cfg.url || !cfg.apiKey) throw new Error("Bugzilla not configured");
  const url = buildUrl(cfg.url, path, [["api_key", cfg.apiKey]]);
  const res = await nodeRequest("PUT", url, JSON.stringify(body), cfg.insecure, timeoutMs);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Bugzilla PUT ${path} → ${res.status}: ${res.body.slice(0, 300)}`);
  }
  return JSON.parse(res.body);
}

// ── Normalizers ───────────────────────────────────────────────────

function daysBetween(iso: string): number {
  if (!iso) return 0;
  const t = new Date(iso.replace("Z", "+00:00")).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

const _CLOSED_SET = new Set<string>(CLOSED_STATUSES);

function computeSla(severity: string, status: string, ageDays: number, daysSinceUpdate: number): "ok" | "warn" | "breach" {
  if (_CLOSED_SET.has(status)) return "ok";
  const high = severity === "Blocker" || severity === "Critical";
  if (high && (ageDays > 30 || daysSinceUpdate > 14)) return "breach";
  if (high && (ageDays > 14 || daysSinceUpdate > 7)) return "warn";
  if (ageDays > 90 || daysSinceUpdate > 30) return "warn";
  return "ok";
}

// Bugzilla's `bug` payload is loose — narrow it as we read fields.
type RawBug = Record<string, unknown>;
const s = (v: unknown, dflt = "") => typeof v === "string" ? v : dflt;
const n = (v: unknown, dflt = 0) => typeof v === "number" ? v : dflt;

function normalizeSummary(raw: RawBug): TicketSummary {
  const ageDays = daysBetween(s(raw.creation_time));
  const updDays = daysBetween(s(raw.last_change_time));
  const severity = s(raw.severity, "Normal") as Severity;
  const status = s(raw.status, "NEW") as TicketStatus;
  // TicketSummary uses `?: string` (undefined-when-absent) — coerce empty
  // values to undefined rather than null so the JSON shape stays minimal.
  return {
    id: n(raw.id),
    summary: s(raw.summary),
    product: s(raw.product),
    component: s(raw.component),
    customer: s(raw.cf_customer) || undefined,
    severity,
    priority: s(raw.priority, "P3"),
    status,
    resolution: s(raw.resolution) || undefined,
    assignee: s(raw.assigned_to),
    reporter: s(raw.creator),
    creationTime: s(raw.creation_time),
    lastChangeTime: s(raw.last_change_time),
    ageDays,
    daysSinceUpdate: updDays,
    slaRisk: computeSla(severity, status, ageDays, updDays),
    label: s(raw.cf_label) || undefined,
    keywords: Array.isArray(raw.keywords) ? (raw.keywords as string[]) : undefined,
  };
}

const SUMMARY_FIELDS =
  "id,summary,status,resolution,product,component,priority,severity," +
  "assigned_to,creator,creation_time,last_change_time,keywords,cf_label,cf_customer";

// ── search ────────────────────────────────────────────────────────

export interface SearchOpts {
  product?: string;
  component?: string;
  status?: string | string[];
  severity?: string | string[];
  assignee?: string;
  cc?: string;
  quicksearch?: string;
  createdSince?: string;     // YYYY-MM-DD lower bound on creation_time
  changedSince?: string;     // YYYY-MM-DD lower bound on last_change_time
  limit?: number;
  offset?: number;
}

export async function search(opts: SearchOpts): Promise<{ tickets: TicketSummary[]; total: number }> {
  const params: Array<readonly [string, string]> = [
    ["limit", String(opts.limit ?? 100)],
    ["offset", String(opts.offset ?? 0)],
    ["include_fields", SUMMARY_FIELDS],
    // Bugzilla's `order` uses buglist column names (changeddate), not REST
    // field names (last_change_time). The REST name is silently ignored
    // and falls back to bug_id ASC.
    ["order", "changeddate DESC"],
  ];
  if (opts.product) params.push(["product", opts.product]);
  if (opts.component) params.push(["component", opts.component]);
  if (opts.assignee) params.push(["assigned_to", opts.assignee]);
  if (opts.cc) params.push(["cc", opts.cc]);
  if (opts.quicksearch) params.push(["quicksearch", opts.quicksearch]);
  if (opts.createdSince) params.push(["creation_time", opts.createdSince]);
  if (opts.changedSince) params.push(["last_change_time", opts.changedSince]);
  const toArr = (v?: string | string[]) => Array.isArray(v) ? v : v ? [v] : [];
  for (const st of toArr(opts.status)) params.push(["status", st]);
  for (const sv of toArr(opts.severity)) params.push(["severity", sv]);

  const data = await bzGet("/rest/bug", params) as { bugs?: RawBug[] };
  const bugs = data.bugs ?? [];
  return { tickets: bugs.map(normalizeSummary), total: bugs.length };
}

// ── fetch (detail + comments + history + attachment metadata) ────

export async function fetchTicket(id: number): Promise<{ ticket: TicketDetail }> {
  // Three parallel reads — Bugzilla's REST returns these on separate paths.
  const [bugRes, commentsRes, historyRes, attachmentsRes] = await Promise.all([
    bzGet(`/rest/bug/${id}`, []) as Promise<{ bugs?: RawBug[] }>,
    bzGet(`/rest/bug/${id}/comment`, []) as Promise<{ bugs?: Record<string, { comments?: RawBug[] }> }>,
    bzGet(`/rest/bug/${id}/history`, []) as Promise<{ bugs?: Array<{ history?: RawBug[] }> }>,
    bzGet(`/rest/bug/${id}/attachment`, [["exclude_fields", "data"]]) as Promise<{ bugs?: Record<string, RawBug[]> }>,
  ]);

  const bug = bugRes.bugs?.[0];
  if (!bug) throw new Error(`Ticket ${id} not found`);

  const summary = normalizeSummary(bug);
  const commentsRaw = commentsRes.bugs?.[String(id)]?.comments ?? [];
  const historyRaw = historyRes.bugs?.[0]?.history ?? [];
  const attachmentsRaw = attachmentsRes.bugs?.[String(id)] ?? [];

  const comments = commentsRaw.map(c => ({
    id: n(c.id),
    count: n(c.count, 0),
    author: s(c.creator),
    time: s(c.creation_time),
    text: s(c.text),
    isPrivate: Boolean(c.is_private),
  }));
  const history = historyRaw.map(h => ({
    who: s(h.who),
    when: s(h.when),
    changes: (Array.isArray(h.changes) ? (h.changes as RawBug[]) : []).map(ch => ({
      field: s(ch.field_name),
      removed: String(ch.removed ?? ""),
      added: String(ch.added ?? ""),
    })),
  }));
  const attachments = attachmentsRaw.map(a => ({
    id: n(a.id),
    fileName: s(a.file_name),
    contentType: s(a.content_type),
    size: n(a.size),
    creator: s(a.creator),
    creationTime: s(a.creation_time),
  }));

  return {
    ticket: {
      ...summary,
      description: comments[0]?.text ?? "",
      cc: (Array.isArray(bug.cc) ? (bug.cc as string[]) : []),
      blocks: (Array.isArray(bug.blocks) ? (bug.blocks as number[]) : []),
      dependsOn: (Array.isArray(bug.depends_on) ? (bug.depends_on as number[]) : []),
      whiteboard: s(bug.whiteboard) || undefined,
      url: s(bug.url) || undefined,
      comments,
      history,
      attachments,
    },
  };
}

// ── submit (post comment + transition + cf_label) ────────────────

export async function submit(opts: {
  id: number;
  comment: string;
  transitionTo?: TicketStatus;
  resolution?: string;
}): Promise<SubmissionReceipt> {
  const { id, comment, transitionTo, resolution } = opts;

  // Validate resolution before mutating anything.
  if (transitionTo === "RESOLVED") {
    if (!resolution || !VALID_RESOLUTIONS.includes(resolution as typeof VALID_RESOLUTIONS[number])) {
      throw new Error(`Invalid or missing resolution. Valid values: ${VALID_RESOLUTIONS.join(", ")}`);
    }
  }

  // 1. Post the comment with the umsemi prefix.
  const body = comment.startsWith(ANALYSIS_PREFIX) ? comment : `${ANALYSIS_PREFIX} ${comment}`;
  const commentRes = await bzPost(`/rest/bug/${id}/comment`, { comment: body }) as { id?: number };
  const commentId = commentRes.id;

  // 2. Append the "Analyzed by Claude" cf_label to whatever's already there.
  //    (PUT /rest/bug/{id} with cf_label set replaces the value, so we
  //    need to merge first.)
  const currentLabelRes = await bzGet(`/rest/bug/${id}`, [["include_fields", "cf_label"]]) as { bugs?: Array<{ cf_label?: string }> };
  const currentLabel = currentLabelRes.bugs?.[0]?.cf_label ?? "";
  const labels = new Set(currentLabel.split(/[;,]\s*/).map(l => l.trim()).filter(Boolean));
  labels.add(CLAUDE_LABEL);
  const mergedLabel = Array.from(labels).join("; ");
  await bzPut(`/rest/bug/${id}`, { cf_label: mergedLabel });

  // 3. Transition if requested.
  let newStatus: TicketStatus | undefined;
  if (transitionTo) {
    const payload: Record<string, string> = { status: transitionTo };
    if (transitionTo === "RESOLVED" && resolution) payload.resolution = resolution;
    await bzPut(`/rest/bug/${id}`, payload);
    newStatus = transitionTo;
  }

  return {
    success: true,
    ticketId: id,
    commentId,
    newStatus,
    postedAt: new Date().toISOString(),
    message: `Posted to Bugzilla (label='${CLAUDE_LABEL}', prefix='${ANALYSIS_PREFIX}')`,
  };
}

// ── products ──────────────────────────────────────────────────────

export async function products(): Promise<{ products: ProductInfo[] }> {
  const data = await bzGet("/rest/product", [
    ["type", "accessible"],
    ["include_fields", "name,is_active,components.name,components.is_active"],
  ]) as { products?: Array<{ name?: string; is_active?: boolean; components?: Array<{ name?: string; is_active?: boolean }> }> };

  const list: ProductInfo[] = [];
  for (const p of data.products ?? []) {
    if (p.is_active === false) continue;
    const components = (p.components ?? [])
      .filter(c => c.is_active !== false)
      .map(c => c.name ?? "")
      .filter(Boolean)
      .sort();
    list.push({ name: p.name ?? "", components });
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return { products: list };
}

// ── whoami (with env-var fallback) ────────────────────────────────

export async function whoami(): Promise<WhoAmI> {
  const cfg = readConfig();
  try {
    const data = await bzGet("/rest/whoami", []) as { name?: string; real_name?: string; id?: number };
    return {
      login: data.name ?? cfg.login,
      realName: data.real_name ?? "",
      id: data.id ?? null,
      source: "whoami",
    };
  } catch {
    // Bugzilla 5.0 doesn't ship /rest/whoami. Fall back to the env login.
    if (!cfg.login) {
      throw new Error("Bugzilla /rest/whoami unavailable and BUGZILLA_LOGIN env var unset");
    }
    return { login: cfg.login, realName: "", id: null, source: "env-fallback" };
  }
}

// ── stats (14 parallel queries) ───────────────────────────────────

export async function stats(opts: { product?: string; component?: string; assignee?: string }): Promise<DashboardStats> {
  const today = new Date();
  const isoDaysAgo = (d: number) => {
    const t = new Date(today.getTime() - d * 86_400_000);
    return t.toISOString().slice(0, 10);
  };
  const d7 = isoDaysAgo(7);
  const d14 = isoDaysAgo(14);

  const base: Array<readonly [string, string]> = [];
  if (opts.product) base.push(["product", opts.product]);
  if (opts.component) base.push(["component", opts.component]);
  if (opts.assignee) base.push(["assigned_to", opts.assignee]);

  const openStatusPairs: Array<readonly [string, string]> = OPEN_STATUSES.map(s => ["status", s] as const);
  const closedStatusPairs: Array<readonly [string, string]> = CLOSED_STATUSES.map(s => ["status", s] as const);
  const bcPairs: Array<readonly [string, string]> = [["severity", "Blocker"], ["severity", "Critical"]];

  // Each query returns a list of bug IDs; we just need the count, so ask
  // for id only and a generous limit. Bugzilla has no count-only endpoint.
  async function countQuery(extra: Params, maxCreation?: string, maxChange?: string): Promise<number> {
    const params: Array<readonly [string, string]> = [
      ...base, ...extra,
      ["include_fields", "id,creation_time,last_change_time"],
      ["limit", "10000"],
    ];
    const data = await bzGet("/rest/bug", params) as { bugs?: Array<{ creation_time?: string; last_change_time?: string }> };
    let bugs = data.bugs ?? [];
    // /rest/bug only accepts a >= lower bound on date fields, so the
    // upper bound for "previous 7d" buckets is filtered client-side.
    if (maxCreation) {
      bugs = bugs.filter(b => (b.creation_time ?? "").slice(0, 10) < maxCreation);
    }
    if (maxChange) {
      bugs = bugs.filter(b => (b.last_change_time ?? "").slice(0, 10) < maxChange);
    }
    return bugs.length;
  }

  // Kick off all 14 queries in parallel.
  const [
    openTotal, openBlocker, openCritical,
    closedTotal, closedBlocker, closedCritical,
    filed7, filed7BC, filedPrev7, filedPrev7BC,
    closed7, closed7BC, closedPrev7, closedPrev7BC,
  ] = await Promise.all([
    countQuery(openStatusPairs),
    countQuery([...openStatusPairs, ["severity", "Blocker"]]),
    countQuery([...openStatusPairs, ["severity", "Critical"]]),
    countQuery(closedStatusPairs),
    countQuery([...closedStatusPairs, ["severity", "Blocker"]]),
    countQuery([...closedStatusPairs, ["severity", "Critical"]]),
    countQuery([["creation_time", d7]]),
    countQuery([["creation_time", d7], ...bcPairs]),
    countQuery([["creation_time", d14]], d7),
    countQuery([["creation_time", d14], ...bcPairs], d7),
    countQuery([...closedStatusPairs, ["last_change_time", d7]]),
    countQuery([...closedStatusPairs, ["last_change_time", d7], ...bcPairs]),
    countQuery([...closedStatusPairs, ["last_change_time", d14]], undefined, d7),
    countQuery([...closedStatusPairs, ["last_change_time", d14], ...bcPairs], undefined, d7),
  ]);

  const last7d = { filed: filed7, filedBC: filed7BC, closed: closed7, closedBC: closed7BC };
  const prev7d = { filed: filedPrev7, filedBC: filedPrev7BC, closed: closedPrev7, closedBC: closedPrev7BC };
  return {
    scope: { product: opts.product ?? null, component: opts.component ?? null, assignee: opts.assignee ?? null },
    open: { total: openTotal, blocker: openBlocker, critical: openCritical },
    closed: { total: closedTotal, blocker: closedBlocker, critical: closedCritical },
    trend: { last7d, prev7d, netFlowPerWeek: last7d.filed - last7d.closed },
    generatedAt: new Date().toISOString(),
  };
}

// ── attachments (base64, for AI ingestion in milestone 2) ────────

export async function attachments(id: number): Promise<{ attachments: Array<{
  id: number; fileName: string; contentType: string; size: number;
  creator: string; creationTime: string; base64: string;
}> }> {
  const data = await bzGet(`/rest/bug/${id}/attachment`, []) as {
    bugs?: Record<string, Array<{ id?: number; file_name?: string; content_type?: string; size?: number; creator?: string; creation_time?: string; data?: string }>>;
  };
  const raw = data.bugs?.[String(id)] ?? [];
  return {
    attachments: raw
      // Skip huge binaries to keep the LLM context manageable.
      .filter(a => (a.size ?? 0) <= 5_000_000)
      .map(a => ({
        id: a.id ?? 0,
        fileName: a.file_name ?? "",
        contentType: a.content_type ?? "",
        size: a.size ?? 0,
        creator: a.creator ?? "",
        creationTime: a.creation_time ?? "",
        // Bugzilla returns attachment data already base64-encoded.
        base64: a.data ?? "",
      })),
  };
}

// ── config probe (matches BridgeConfig shape so callers don't change) ──

export interface BridgeConfig {
  bugzillaUrl: string;
  bugzillaMcpPath: string;     // kept for backwards-compat; now always ""
  insecure: boolean;
  hasApiKey: boolean;
  login: string;
  claudeLabel: string;
  analysisPrefix: string;
  validResolutions: string[];
}

export function getConfig(): BridgeConfig {
  const cfg = readConfig();
  return {
    bugzillaUrl: cfg.url,
    bugzillaMcpPath: "",
    insecure: cfg.insecure,
    hasApiKey: Boolean(cfg.apiKey),
    login: cfg.login,
    claudeLabel: CLAUDE_LABEL,
    analysisPrefix: ANALYSIS_PREFIX,
    validResolutions: [...VALID_RESOLUTIONS],
  };
}
