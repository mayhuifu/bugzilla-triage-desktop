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
import { getEffectiveSettings } from "./settings";
import { auditBugzillaWrite } from "./audit";

// ── Configuration ─────────────────────────────────────────────────

/** umsemi-specific conventions, previously imported from the bugzilla-mcp
 * skill module. Centralized here so we only have one place to update if
 * resolution vocabulary changes.
 *
 * Naming history: these used to be "Analyzed by Claude:" / "Analyzed by Claude"
 * back when the only supported LLM was Anthropic's Claude. Once the app gained
 * multi-provider support (OpenAI, DeepSeek, Ollama, etc.) the Claude-specific
 * wording became misleading on real Bugzilla comments. The neutral "AI Triage
 * Bot" label/prefix is what's written to Bugzilla today. Recognizers in the
 * UI (see TicketComments / TicketTable) still match the old strings too so
 * historical tickets keep their AI-styling. */
export const ANALYSIS_PREFIX = "Analyzed by AI Triage Bot:";
export const ANALYSIS_LABEL = "Analyzed by AI Triage Bot";
/** @deprecated kept for any external code that imported the old symbol name. */
export const CLAUDE_LABEL = ANALYSIS_LABEL;
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
  // Desktop: global settings. Server mode: the request's user (their Bugzilla
  // key) via getEffectiveSettings() → all reads/writes act AS them.
  const s = getEffectiveSettings();
  return {
    url: (s.bugzillaUrl || "").replace(/\/$/, ""),
    apiKey: s.bugzillaApiKey,
    insecure: s.bugzillaInsecure,
    login: s.bugzillaLogin,
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
  connectTimeoutMs = 5_000,
): Promise<HttpRes> {
  return new Promise((resolve, reject) => {
    const u = new URL(fullUrl);
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;

    // Two-phase timeout. `connectTimeoutMs` is a short ceiling on
    // ESTABLISHING the connection (DNS + TCP + TLS) — when the internal
    // Bugzilla host is unreachable (VPN down → resolves to a placeholder IP
    // that never completes the handshake), this fails in a few seconds
    // instead of blocking on the long response timeout. Once the socket is
    // connected we clear it, so `timeoutMs` (generous) governs the actual
    // response — large stats count-queries can legitimately take many
    // seconds and must NOT be cut off.
    let connected = false;
    const connectTimer = setTimeout(() => {
      if (!connected) req.destroy(new Error(`connect timeout after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);
    const markConnected = () => { connected = true; clearTimeout(connectTimer); };

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
        markConnected();
        const chunks: Buffer[] = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
        res.on("error", reject);
      },
    );
    req.on("socket", s => {
      s.on("connect", markConnected);       // plain HTTP
      s.on("secureConnect", markConnected); // HTTPS (after TLS handshake)
    });
    req.on("error", err => { clearTimeout(connectTimer); reject(err); });
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    if (body) req.write(body);
    req.end();
  });
}

async function bzGet(path: string, params: Params, timeoutMs = 30_000): Promise<unknown> {
  const cfg = readConfig();
  if (!cfg.url || !cfg.apiKey) {
    throw new Error("Bugzilla not configured — open Settings (gear icon) and enter your URL + API key");
  }
  const url = buildUrl(cfg.url, path, [["api_key", cfg.apiKey], ...params]);

  // Retry transient TLS / connection-reset errors common on internal VPN
  // tunnels — but FAIL FAST when the host is simply unreachable. The old
  // 4-attempt loop turned a VPN-down state into a ~12s freeze per request
  // (and the dashboard fires ~16 at once). Now: at most 2 attempts (1
  // retry catches a genuine transient blip), each capped by the short
  // connect timeout in nodeRequest, plus an overall budget so the worst
  // case is ~6-7s instead of ~12s. The Refresh button is the recovery path
  // if a real blip outlasts the single retry.
  const MAX_ATTEMPTS = 2;
  const TOTAL_BUDGET_MS = 9_000;
  const startedAt = Date.now();
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await nodeRequest("GET", url, undefined, cfg.insecure, timeoutMs);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Bugzilla GET ${path} → ${res.status}: ${res.body.slice(0, 300)}`);
      }
      return JSON.parse(res.body);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const retryable = /ECONNRESET|EPIPE|ETIMEDOUT|timeout|SSL|TLS|socket hang up|UNABLE_TO|connect timeout/i.test(msg);
      const budgetLeft = TOTAL_BUDGET_MS - (Date.now() - startedAt);
      if (!retryable || attempt === MAX_ATTEMPTS - 1 || budgetLeft < 1_500) break;
      await new Promise(r => setTimeout(r, 400));
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

/** Days until the given YYYY-MM-DD date. Positive = future, negative = past.
 *  Returns null when the input is empty or unparseable. Treats the date as
 *  end-of-day UTC so a deadline of "2026-05-22" counts as "still on track"
 *  for the whole calendar day, only flipping to breach the moment May 23
 *  starts (UTC). */
export function daysUntilIso(iso: string): number | null {
  if (!iso) return null;
  const t = new Date(iso + "T23:59:59Z").getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

/** Compute the SLA risk band.
 *
 *  Precedence:
 *    1. Closed tickets → always "ok" (no SLA on closed work).
 *    2. Explicit due_date (Bugzilla `deadline` field) — if set, IT drives
 *       the result and the default age-based logic is bypassed:
 *         - due in the past         → "breach"
 *         - due in ≤ 5 days         → "warn"   ("at risk")
 *         - due in > 5 days         → "ok"     (override the default —
 *                                                a customer set a deadline,
 *                                                trust it over the
 *                                                severity/age heuristic)
 *    3. No due_date → fall back to the historical default:
 *         - Blocker/Critical: > 30d old or > 14d since update → breach
 *         - Blocker/Critical: > 14d old or >  7d since update → warn
 *         - Anything: > 90d old or > 30d since update         → warn
 *         - Otherwise                                          → ok
 *
 *  Rationale for rule 2 fully overriding: users who set an explicit
 *  deadline are signalling "this is the real SLA" — the default
 *  heuristic shouldn't shout "breach" at a 35-day-old Critical bug
 *  that has a customer-agreed deadline two months out. */
function computeSla(
  severity: string,
  status: string,
  ageDays: number,
  daysSinceUpdate: number,
  dueDate?: string,
): "ok" | "warn" | "breach" {
  if (_CLOSED_SET.has(status)) return "ok";

  if (dueDate) {
    const daysUntil = daysUntilIso(dueDate);
    if (daysUntil != null) {
      if (daysUntil < 0) return "breach";
      if (daysUntil <= 5) return "warn";
      return "ok";
    }
  }

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
  // Bugzilla's REST API serializes the due-date field as `deadline` —
  // a YYYY-MM-DD string when set, missing or empty when not. Coerce to
  // undefined for the un-set case so the JSON payload stays minimal.
  const dueDate = s(raw.deadline) || undefined;
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
    slaRisk: computeSla(severity, status, ageDays, updDays, dueDate),
    dueDate,
    label: s(raw.cf_label) || undefined,
    keywords: Array.isArray(raw.keywords) ? (raw.keywords as string[]) : undefined,
  };
}

const SUMMARY_FIELDS =
  "id,summary,status,resolution,product,component,priority,severity," +
  "assigned_to,creator,creation_time,last_change_time,keywords,cf_label,cf_customer," +
  // `deadline` is Bugzilla's standard due-date field (YYYY-MM-DD when set,
  // empty otherwise). Pulled at summary level so the SLA chip on every
  // dashboard row can prefer due-date over the default age heuristic.
  "deadline";

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

/** Render a comment body as a markdown code block by 4-space-indenting
 *  every line. The umsemi Bugzilla renders markdown but apparently
 *  doesn't recognise the modern triple-backtick fenced-code-block
 *  syntax — we tried it (commit history references `wrapInCodeFence`)
 *  and the rendered output still had collapsed bullets and italicized
 *  underscores. 4-space indentation is the ORIGINAL Gruber-Markdown
 *  code-block syntax and is supported by every renderer, including
 *  the older Bugzilla::Markdown variants.
 *
 *  Every non-empty line gets a 4-space prefix. Blank lines stay blank
 *  (CommonMark accepts either bare or 4-space-prefixed blanks inside
 *  an indented block). The markdown engine then renders the whole
 *  block as `<pre><code>...</code></pre>` — every newline, hyphen,
 *  indent, and underscore preserved as written. Identifiers like
 *  `harq_gain_param_input` survive (no italics), section headers
 *  with `=========` underlines don't become H1, and hyphen-bullets
 *  on separate lines stay on separate lines. */
function indentAsCodeBlock(text: string): string {
  // Normalize CRLF to LF first so the prefix lands per-line correctly.
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return lines
    .map(line => (line.length === 0 ? "" : "    " + line))
    .join("\n");
}

// ── submit (post comment + transition + cf_label) ────────────────

export async function submit(opts: {
  id: number;
  comment: string;
  transitionTo?: TicketStatus;
  resolution?: string;
  /** When true: skip the "Analyzed by AI Triage Bot:" prefix AND skip
   *  appending the matching cf_label. Used by the manual-triage path where
   *  a human authored the comment without AI assistance — mis-attributing
   *  it to the bot would be misleading. */
  manual?: boolean;
}): Promise<SubmissionReceipt> {
  const { id, comment, transitionTo, resolution, manual } = opts;

  // Validate resolution before mutating anything.
  if (transitionTo === "RESOLVED") {
    if (!resolution || !VALID_RESOLUTIONS.includes(resolution as typeof VALID_RESOLUTIONS[number])) {
      throw new Error(`Invalid or missing resolution. Valid values: ${VALID_RESOLUTIONS.join(", ")}`);
    }
  }

  // 1. Post the comment. AI flow auto-prefixes with "Analyzed by AI Triage Bot:";
  //    manual flow posts the comment as-typed.
  //
  // Bugzilla rendering: we tried `is_markdown: false` but the umsemi
  // server ignores it (some Bugzilla installs force markdown on
  // regardless). Empirical evidence from a posted comment:
  //   - "Analyzed by AI Triage Bot: CLASSIFICATION\n=============="
  //     rendered as a Setext H1 heading (the ==== underline grabbed
  //     the prefix line as a level-1 header)
  //   - "harq_gain_param_input" rendered as "harq*gain*param*input"
  //     (underscores treated as italic markers)
  //   - Hyphen-bullets across separate lines collapsed into one
  //     flowing paragraph because markdown treats single newlines as
  //     spaces
  //
  // Reliable workaround: wrap the structured body in a markdown
  // CODE FENCE (```…```) so the renderer treats it as preformatted
  // monospace text. The Analyzed-by-AI-Triage-Bot prefix stays
  // OUTSIDE the fence so it renders as a normal plain-text paragraph
  // (no Setext H1 surprise) — and the fenced content keeps every
  // newline, indent, hyphen, and underscore intact. We also keep
  // is_markdown=false as belt-and-suspenders: harmless if the server
  // ignores it, an extra guard if it doesn't.
  const stripped = comment.startsWith(ANALYSIS_PREFIX)
    ? comment.slice(ANALYSIS_PREFIX.length).replace(/^\s+/, "")
    : comment;
  // A blank line BEFORE the indented block is required by markdown
  // for the renderer to recognise it as a code block (otherwise it
  // gets merged into the preceding paragraph and loses the <pre>
  // treatment). We include two newlines after the prefix to be safe.
  const body = manual
    ? indentAsCodeBlock(comment)
    : `${ANALYSIS_PREFIX}\n\n${indentAsCodeBlock(stripped)}`;
  const commentRes = await bzPost(`/rest/bug/${id}/comment`, {
    comment: body,
    is_markdown: false,
  }) as { id?: number };
  const commentId = commentRes.id;
  auditBugzillaWrite("comment", id);

  // 2. Append the "Analyzed by AI Triage Bot" cf_label — AI flow only.
  //    (PUT /rest/bug/{id} with cf_label set replaces the value, so we
  //    need to merge first.)
  if (!manual) {
    const currentLabelRes = await bzGet(`/rest/bug/${id}`, [["include_fields", "cf_label"]]) as { bugs?: Array<{ cf_label?: string }> };
    const currentLabel = currentLabelRes.bugs?.[0]?.cf_label ?? "";
    const labels = new Set(currentLabel.split(/[;,]\s*/).map(l => l.trim()).filter(Boolean));
    labels.add(ANALYSIS_LABEL);
    const mergedLabel = Array.from(labels).join("; ");
    await bzPut(`/rest/bug/${id}`, { cf_label: mergedLabel });
    auditBugzillaWrite("label", id);
  }

  // 3. Transition if requested.
  let newStatus: TicketStatus | undefined;
  if (transitionTo) {
    const payload: Record<string, string> = { status: transitionTo };
    if (transitionTo === "RESOLVED" && resolution) payload.resolution = resolution;
    await bzPut(`/rest/bug/${id}`, payload);
    auditBugzillaWrite("status", id, transitionTo);
    newStatus = transitionTo;
  }

  return {
    success: true,
    ticketId: id,
    commentId,
    newStatus,
    postedAt: new Date().toISOString(),
    message: manual
      ? "Posted to Bugzilla (manual triage — no AI prefix or label)"
      : `Posted to Bugzilla (label='${ANALYSIS_LABEL}', prefix='${ANALYSIS_PREFIX}')`,
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

// ── user search (typeahead for assignee filter) ──────────────────
//
// Wraps Bugzilla's `/rest/user?match=<x>` endpoint, which searches the
// `real_name` and email (Bugzilla's `name` field IS the email login)
// for a case-insensitive substring match. Used by the assignee-search
// typeahead in the dashboard's filter row — lets the user pick ANY
// engineer on the Bugzilla, not just those visible in the currently-
// loaded 25-row page.
//
// Limits: Bugzilla's `match` requires the search term to be at least 3
// chars OR an exact email; for shorter inputs we skip the round-trip
// upstream. The result is capped to keep the dropdown manageable —
// the user is expected to keep typing if their hit is past the cap.

export interface BugzillaUser {
  /** Bugzilla user-id (numeric, stable). Not currently used downstream
   *  — kept on the wire so future per-user lookups don't need a
   *  re-search to find it. */
  id: number;
  /** Login / email — what gets sent as the `assignee` param. Bugzilla
   *  REST exposes this as the `name` field. */
  name: string;
  /** Display name ("Joachim Wehinger"). Rendered as the primary line in
   *  the typeahead row, with the email shown underneath. May be empty
   *  for users who never set their real name. */
  realName: string;
}

export async function findUsers(match: string, limit = 20): Promise<{ users: BugzillaUser[] }> {
  const trimmed = match.trim();
  if (!trimmed) return { users: [] };
  const params: Params = [
    ["match", trimmed],
    ["limit", String(limit)],
    // Tighten the payload — these are all the fields the typeahead needs.
    ["include_fields", "id,name,real_name"],
  ];
  const data = await bzGet("/rest/user", params) as {
    users?: Array<{ id?: number; name?: string; real_name?: string }>;
  };
  const raw = data.users ?? [];
  return {
    users: raw.map(u => ({
      id: u.id ?? 0,
      name: u.name ?? "",
      realName: u.real_name ?? "",
    })),
  };
}

// ── stats (14 parallel queries) ───────────────────────────────────

/** Which slice of the dashboard stats to compute. The 14 underlying
 *  Bugzilla count-queries split into 6 "core" (the open/closed cards) and
 *  8 "trend" (the week-over-week bar). The dashboard fetches the two parts
 *  separately so the cards paint after 6 queries instead of waiting for all
 *  14 — roughly halving time-to-first-content on a slow Bugzilla. */
export type StatsPart = "core" | "trend" | "all";

export async function stats(
  opts: { product?: string; component?: string; assignee?: string },
  part: StatsPart = "all",
): Promise<Partial<DashboardStats> & { scope: DashboardStats["scope"]; generatedAt: string }> {
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
  // for id only and paginate with `offset` to avoid the silent cap of
  // 10000 that the single-call version hit on large Bugzillas.
  // Bugzilla's `/rest/bug` has no count-only endpoint; this is the only
  // way short of running a SQL query directly.
  //
  // PAGE_SIZE is the server-side max (also the historical hard-coded cap
  // — Bugzilla's default `max_search_results` is 10000). SAFETY_MAX_PAGES
  // caps the worst case at ~500k bugs per query, well above anything
  // realistic; if a real install hits that bound we'd see the warning
  // and revisit. Without this safety, a misconfigured Bugzilla returning
  // a full page every time would loop forever.
  async function countQuery(extra: Params, maxCreation?: string, maxChange?: string): Promise<number> {
    const PAGE_SIZE = 10000;
    const SAFETY_MAX_PAGES = 50;
    let total = 0;
    for (let page = 0; page < SAFETY_MAX_PAGES; page++) {
      const params: Array<readonly [string, string]> = [
        ...base, ...extra,
        ["include_fields", "id,creation_time,last_change_time"],
        ["limit", String(PAGE_SIZE)],
        ["offset", String(page * PAGE_SIZE)],
      ];
      const data = await bzGet("/rest/bug", params) as { bugs?: Array<{ creation_time?: string; last_change_time?: string }> };
      const rawBugs = data.bugs ?? [];
      let bugs = rawBugs;
      // /rest/bug only accepts a >= lower bound on date fields, so the
      // upper bound for "previous 7d" buckets is filtered client-side.
      if (maxCreation) {
        bugs = bugs.filter(b => (b.creation_time ?? "").slice(0, 10) < maxCreation);
      }
      if (maxChange) {
        bugs = bugs.filter(b => (b.last_change_time ?? "").slice(0, 10) < maxChange);
      }
      total += bugs.length;
      // Pagination terminator: short page = end of result set. Break on
      // rawBugs (server-side count), not the post-filter count, because
      // a date-window filter can reduce a full page to a partial one.
      if (rawBugs.length < PAGE_SIZE) return total;
    }
    // eslint-disable-next-line no-console
    console.warn(`[bugzilla] countQuery hit SAFETY_MAX_PAGES (${SAFETY_MAX_PAGES} * ${PAGE_SIZE} = ${SAFETY_MAX_PAGES * PAGE_SIZE}); result may be undercounted`);
    return total;
  }

  const scope = {
    product: opts.product ?? null,
    component: opts.component ?? null,
    assignee: opts.assignee ?? null,
  };
  const wantCore = part === "core" || part === "all";
  const wantTrend = part === "trend" || part === "all";

  // CORE — the 6 open/closed card counts.
  const corePromise = wantCore
    ? Promise.all([
        countQuery(openStatusPairs),
        countQuery([...openStatusPairs, ["severity", "Blocker"]]),
        countQuery([...openStatusPairs, ["severity", "Critical"]]),
        countQuery(closedStatusPairs),
        countQuery([...closedStatusPairs, ["severity", "Blocker"]]),
        countQuery([...closedStatusPairs, ["severity", "Critical"]]),
      ])
    : null;

  // TREND — the 8 week-over-week filed/closed counts.
  const trendPromise = wantTrend
    ? Promise.all([
        countQuery([["creation_time", d7]]),
        countQuery([["creation_time", d7], ...bcPairs]),
        countQuery([["creation_time", d14]], d7),
        countQuery([["creation_time", d14], ...bcPairs], d7),
        countQuery([...closedStatusPairs, ["last_change_time", d7]]),
        countQuery([...closedStatusPairs, ["last_change_time", d7], ...bcPairs]),
        countQuery([...closedStatusPairs, ["last_change_time", d14]], undefined, d7),
        countQuery([...closedStatusPairs, ["last_change_time", d14], ...bcPairs], undefined, d7),
      ])
    : null;

  const [coreRes, trendRes] = await Promise.all([corePromise, trendPromise]);

  const result: Partial<DashboardStats> & { scope: DashboardStats["scope"]; generatedAt: string } = {
    scope,
    generatedAt: new Date().toISOString(),
  };

  if (coreRes) {
    const [openTotal, openBlocker, openCritical, closedTotal, closedBlocker, closedCritical] = coreRes;
    result.open = { total: openTotal, blocker: openBlocker, critical: openCritical };
    result.closed = { total: closedTotal, blocker: closedBlocker, critical: closedCritical };
  }
  if (trendRes) {
    const [filed7, filed7BC, filedPrev7, filedPrev7BC, closed7, closed7BC, closedPrev7, closedPrev7BC] = trendRes;
    const last7d = { filed: filed7, filedBC: filed7BC, closed: closed7, closedBC: closed7BC };
    const prev7d = { filed: filedPrev7, filedBC: filedPrev7BC, closed: closedPrev7, closedBC: closedPrev7BC };
    result.trend = { last7d, prev7d, netFlowPerWeek: last7d.filed - last7d.closed };
  }
  return result;
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
  /** @deprecated alias for analysisLabel — kept for callers that pre-dated
   *  the multi-provider rename. New code should read analysisLabel. */
  claudeLabel: string;
  analysisLabel: string;
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
    claudeLabel: ANALYSIS_LABEL,
    analysisLabel: ANALYSIS_LABEL,
    analysisPrefix: ANALYSIS_PREFIX,
    validResolutions: [...VALID_RESOLUTIONS],
  };
}
