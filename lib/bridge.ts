// ─────────────────────────────────────────────────────────────────
// bridge.ts — invoke the Python bridges (bz_bridge.py, triage_llm.py)
// from the Next.js API routes. Server-side only.
//
// Why subprocess instead of direct REST? The user's existing
// bugzilla-mcp/skills/bugzilla_analyze.py + skills/domain_3gpp.py
// already encode the umsemi workflow rules (comment prefix, label,
// allowed resolutions, 4-layer triage scaffold, 3GPP standards
// context). Re-implementing them in TS would drift; calling the
// Python skills directly keeps both surfaces in lockstep.
// ─────────────────────────────────────────────────────────────────

import { spawn } from "child_process";
import path from "path";

const REPO_ROOT = path.resolve(process.cwd());
const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");

// `uv run --with requests python script.py …` automatically provisions
// a venv with the required deps (httpx, requests, urllib3) so the
// dashboard works on a fresh checkout without a separate pip install.
const UV_BIN = process.env.UV_BIN || `${process.env.HOME}/.local/bin/uv`;
const BUGZILLA_MCP_PATH = process.env.BUGZILLA_MCP_PATH || path.resolve(REPO_ROOT, "..", "bugzilla-mcp");

interface RunOptions {
  args: string[];           // command-line args to pass to the Python script
  script: "bz_bridge" | "triage_llm";
  stdin?: string;           // optional JSON to pipe to stdin (used by triage_llm)
  timeoutMs?: number;
}

// Python bridges print `===RESULT===\n{json}` as their final line so we can
// extract the result deterministically even if late stderr/urllib3 warnings
// leak into stdout after the JSON.
const RESULT_SENTINEL = "===RESULT===";

function extractResultJson(stdout: string): unknown | null {
  const idx = stdout.lastIndexOf(RESULT_SENTINEL);
  const candidates: string[] = [];
  if (idx !== -1) {
    candidates.push(stdout.slice(idx + RESULT_SENTINEL.length).trim());
  }
  // Backwards-compat: last non-empty line, then any other line that parses.
  const lines = stdout.trim().split("\n").map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) candidates.push(lines[i]);

  for (const c of candidates) {
    if (!c.startsWith("{")) continue;
    try { return JSON.parse(c); } catch { /* keep scanning */ }
  }
  return null;
}

export async function runBridge<T = unknown>(opts: RunOptions): Promise<T> {
  const scriptPath = path.join(SCRIPTS_DIR, `${opts.script}.py`);
  const cmdArgs = [
    "run",
    "--directory", BUGZILLA_MCP_PATH,
    "--with", "requests",
    "--with", "urllib3",
    "python",
    scriptPath,
    ...opts.args,
  ];

  return new Promise<T>((resolve, reject) => {
    const proc = spawn(UV_BIN, cmdArgs, {
      env: {
        ...process.env,
        BUGZILLA_MCP_PATH,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (fn: () => void) => { if (settled) return; settled = true; fn(); };

    proc.stdout.on("data", chunk => { stdout += chunk.toString(); });
    proc.stderr.on("data", chunk => { stderr += chunk.toString(); });

    const timeoutMs = opts.timeoutMs || 60_000;
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      // Escalate to SIGKILL if the process ignores SIGTERM. Avoids orphaned
      // uv/python processes when the underlying claude CLI is hung.
      const killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* dead */ } }, 5_000);
      killTimer.unref?.();
      settle(() => reject(new Error(`bridge ${opts.script} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    proc.on("close", code => {
      clearTimeout(timer);
      const parsed = extractResultJson(stdout);

      if (code !== 0 || !parsed) {
        const errMsg = `bridge ${opts.script} exit=${code}; stderr: ${stderr.slice(0, 400)}; stdout: ${stdout.slice(0, 400)}`;
        settle(() => reject(new Error(errMsg)));
        return;
      }
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        settle(() => reject(new Error((parsed as { error: string }).error)));
        return;
      }
      settle(() => resolve(parsed as T));
    });

    proc.on("error", err => {
      clearTimeout(timer);
      settle(() => reject(err));
    });

    if (opts.stdin) {
      proc.stdin.write(opts.stdin);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }
  });
}

// ─── Convenience wrappers ─────────────────────────────────────────

import type {
  TicketSummary, TicketDetail, TriageResult, SubmissionReceipt, TicketStatus,
  ProductInfo, WhoAmI, DashboardStats,
} from "./types";

export async function bridgeSearch(opts: {
  product?: string; component?: string; status?: string;
  severity?: string; assignee?: string; quicksearch?: string;
  limit?: number; offset?: number;
}): Promise<{ tickets: TicketSummary[]; total: number }> {
  const args: string[] = ["search"];
  if (opts.product) args.push("--product", opts.product);
  if (opts.component) args.push("--component", opts.component);
  if (opts.status) args.push("--status", opts.status);
  if (opts.severity) args.push("--severity", opts.severity);
  if (opts.assignee) args.push("--assignee", opts.assignee);
  if (opts.quicksearch) args.push("--quicksearch", opts.quicksearch);
  args.push("--limit", String(opts.limit ?? 100));
  args.push("--offset", String(opts.offset ?? 0));
  return runBridge({ script: "bz_bridge", args, timeoutMs: 45_000 });
}

export async function bridgeFetch(id: number): Promise<{ ticket: TicketDetail }> {
  return runBridge({ script: "bz_bridge", args: ["fetch", String(id)], timeoutMs: 45_000 });
}

export async function bridgeSubmit(opts: {
  id: number;
  comment: string;
  transitionTo?: TicketStatus;
  resolution?: string;
}): Promise<SubmissionReceipt> {
  // Pass the comment via a temp file to avoid shell-arg length issues
  const fs = await import("fs/promises");
  const os = await import("os");
  const tmpPath = path.join(os.tmpdir(), `triage_${opts.id}_${Date.now()}.txt`);
  await fs.writeFile(tmpPath, opts.comment, "utf8");

  const args = ["submit", String(opts.id), "--file", tmpPath];
  if (opts.transitionTo) args.push("--transition-to", opts.transitionTo);
  if (opts.resolution) args.push("--resolution", opts.resolution);

  try {
    return await runBridge<SubmissionReceipt>({
      script: "bz_bridge",
      args,
      timeoutMs: 45_000,
    });
  } finally {
    fs.unlink(tmpPath).catch(() => {});
  }
}

export async function bridgeTriage(
  ticket: TicketDetail,
  opts: { followup?: string; model?: string; timeoutMs?: number } = {}
): Promise<{ triage: TriageResult }> {
  const args: string[] = [];
  if (opts.followup) args.push("--followup", opts.followup);
  if (opts.model) args.push("--model", opts.model);
  // Bound the claude CLI timeout slightly below ours so we capture its stderr
  const timeoutSec = Math.floor((opts.timeoutMs || 240_000) / 1000) - 10;
  args.push("--timeout", String(Math.max(60, timeoutSec)));

  return runBridge({
    script: "triage_llm",
    args,
    stdin: JSON.stringify({ ticket }),
    timeoutMs: opts.timeoutMs || 240_000,
  });
}

export async function bridgeProducts(): Promise<{ products: ProductInfo[] }> {
  return runBridge({ script: "bz_bridge", args: ["products"], timeoutMs: 30_000 });
}

export async function bridgeWhoami(): Promise<WhoAmI> {
  return runBridge({ script: "bz_bridge", args: ["whoami"], timeoutMs: 15_000 });
}

export async function bridgeStats(opts: {
  product?: string; component?: string; assignee?: string;
}): Promise<DashboardStats> {
  const args = ["stats"];
  if (opts.product) args.push("--product", opts.product);
  if (opts.component) args.push("--component", opts.component);
  if (opts.assignee) args.push("--assignee", opts.assignee);
  // 14 parallel Bugzilla queries; allow generous headroom for slow VPN.
  return runBridge({ script: "bz_bridge", args, timeoutMs: 60_000 });
}

// ─── Config probe ─────────────────────────────────────────────────

export interface BridgeConfig {
  bugzillaUrl: string;
  bugzillaMcpPath: string;
  insecure: boolean;
  hasApiKey: boolean;
  login: string;
  claudeLabel: string;
  analysisPrefix: string;
  validResolutions: string[];
}

// Success is cached forever (config is static within a process). Errors are
// cached for a short TTL only — otherwise a transient cold-start failure
// (VPN coming up, slow uv venv build) would permanently break the app.
const CONFIG_ERROR_TTL_MS = 30_000;
let configCache: BridgeConfig | null = null;
let configCacheError: { message: string; expiresAt: number } | null = null;

export async function getBridgeConfig(): Promise<{ config: BridgeConfig | null; error: string | null }> {
  if (configCache) return { config: configCache, error: null };
  if (configCacheError && Date.now() < configCacheError.expiresAt) {
    return { config: null, error: configCacheError.message };
  }
  try {
    configCache = await runBridge<BridgeConfig>({ script: "bz_bridge", args: ["config"], timeoutMs: 15_000 });
    configCacheError = null;
    return { config: configCache, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    configCacheError = { message, expiresAt: Date.now() + CONFIG_ERROR_TTL_MS };
    return { config: null, error: message };
  }
}
