// ─────────────────────────────────────────────────────────────────
// bridge.ts — Python triage subprocess + Bugzilla REST delegation.
//
// Until milestone 1, this file owned both: spawning bz_bridge.py for
// Bugzilla REST calls, AND spawning triage_llm.py for AI triage.
//
// Milestone 1 moved Bugzilla REST into lib/bugzilla.ts (pure TS, no
// Python). This file now re-exports the same names so the API routes
// don't need to change, and still handles the triage subprocess.
//
// Milestone 2 will replace triage_llm.py with the Anthropic SDK and
// delete the subprocess machinery entirely.
// ─────────────────────────────────────────────────────────────────

import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";

import type { TicketDetail, TriageResult } from "./types";

import {
  search, fetchTicket, submit, products, whoami, stats, getConfig,
  type BridgeConfig as BugzillaConfig,
} from "./bugzilla";

const REPO_ROOT = path.resolve(process.cwd());
const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");

const UV_BIN = process.env.UV_BIN || `${process.env.HOME}/.local/bin/uv`;

// Bugzilla-mcp path is no longer required for read/submit operations — they
// run through lib/bugzilla.ts. It's still resolved for the triage step
// because triage_llm.py imports a few helpers from the skills package.
function resolveBugzillaMcpPath(): string {
  const env = process.env.BUGZILLA_MCP_PATH;
  if (env) return env;
  const peer = path.resolve(REPO_ROOT, "..", "bugzilla-mcp");
  if (existsSync(path.join(peer, ".mcp.json"))) return peer;
  const home = path.join(process.env.HOME || "", "bugzilla-mcp");
  if (existsSync(path.join(home, ".mcp.json"))) return home;
  return peer;
}
const BUGZILLA_MCP_PATH = resolveBugzillaMcpPath();

interface RunOptions {
  args: string[];
  script: "triage_llm";
  stdin?: string;
  timeoutMs?: number;
}

const RESULT_SENTINEL = "===RESULT===";

function extractResultJson(stdout: string): unknown | null {
  const idx = stdout.lastIndexOf(RESULT_SENTINEL);
  const candidates: string[] = [];
  if (idx !== -1) candidates.push(stdout.slice(idx + RESULT_SENTINEL.length).trim());
  const lines = stdout.trim().split("\n").map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) candidates.push(lines[i]);
  for (const c of candidates) {
    if (!c.startsWith("{")) continue;
    try { return JSON.parse(c); } catch { /* keep scanning */ }
  }
  return null;
}

async function runBridge<T = unknown>(opts: RunOptions): Promise<T> {
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
      env: { ...process.env, BUGZILLA_MCP_PATH },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (fn: () => void) => { if (settled) return; settled = true; fn(); };
    proc.stdout.on("data", c => { stdout += c.toString(); });
    proc.stderr.on("data", c => { stderr += c.toString(); });
    const timeoutMs = opts.timeoutMs || 60_000;
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      const killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* dead */ } }, 5_000);
      killTimer.unref?.();
      settle(() => reject(new Error(`bridge ${opts.script} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    proc.on("close", code => {
      clearTimeout(timer);
      const parsed = extractResultJson(stdout);
      if (code !== 0 || !parsed) {
        settle(() => reject(new Error(`bridge ${opts.script} exit=${code}; stderr: ${stderr.slice(0, 400)}; stdout: ${stdout.slice(0, 400)}`)));
        return;
      }
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        settle(() => reject(new Error((parsed as { error: string }).error)));
        return;
      }
      settle(() => resolve(parsed as T));
    });
    proc.on("error", err => { clearTimeout(timer); settle(() => reject(err)); });
    if (opts.stdin) { proc.stdin.write(opts.stdin); proc.stdin.end(); }
    else proc.stdin.end();
  });
}

// ─── Triage (still subprocess for now — milestone 2 replaces this) ──

export async function bridgeTriage(
  ticket: TicketDetail,
  opts: { followup?: string; model?: string; timeoutMs?: number } = {}
): Promise<{ triage: TriageResult }> {
  const args: string[] = [];
  if (opts.followup) args.push("--followup", opts.followup);
  if (opts.model) args.push("--model", opts.model);
  const timeoutSec = Math.floor((opts.timeoutMs || 240_000) / 1000) - 10;
  args.push("--timeout", String(Math.max(60, timeoutSec)));
  return runBridge({
    script: "triage_llm",
    args,
    stdin: JSON.stringify({ ticket }),
    timeoutMs: opts.timeoutMs || 240_000,
  });
}

// ─── Bugzilla REST — thin pass-throughs to the new TS client ───────

export async function bridgeSearch(opts: Parameters<typeof search>[0]) {
  return search(opts);
}

export async function bridgeFetch(id: number) {
  return fetchTicket(id);
}

export async function bridgeSubmit(opts: Parameters<typeof submit>[0]) {
  return submit(opts);
}

export async function bridgeProducts() {
  return products();
}

export async function bridgeWhoami() {
  return whoami();
}

export async function bridgeStats(opts: Parameters<typeof stats>[0]) {
  return stats(opts);
}

// ─── Config probe (synchronous now — no subprocess, no caching needed) ──

export type BridgeConfig = BugzillaConfig;

export async function getBridgeConfig(): Promise<{ config: BridgeConfig | null; error: string | null }> {
  try {
    return { config: getConfig(), error: null };
  } catch (err) {
    return { config: null, error: err instanceof Error ? err.message : String(err) };
  }
}
