// ─────────────────────────────────────────────────────────────────
// bridge.ts — re-export façade for the API routes.
//
// As of milestone 2, this app is **pure TypeScript end-to-end** —
// no Python, no `uv`, no `bugzilla-mcp` clone, no `claude` CLI.
// Bugzilla calls go through lib/bugzilla.ts; AI triage goes through
// lib/llm.ts (Anthropic SDK).
//
// This file stays as a thin shim so the existing API route imports
// (`@/lib/bridge` → `bridgeSearch`/`bridgeFetch`/`bridgeTriage`/…)
// keep working without churn. A future milestone could collapse
// these into direct imports and delete this file entirely.
// ─────────────────────────────────────────────────────────────────

import type { TicketDetail, TriageResult } from "./types";

import {
  search, fetchTicket, submit, products, whoami, stats, getConfig, findUsers,
  type BridgeConfig as BugzillaConfig,
} from "./bugzilla";

import { runTriage, type TriageOptions } from "./llm";

// ─── Bugzilla REST — pass-throughs to the TS client ────────────────

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

export async function bridgeFindUsers(match: string, limit?: number) {
  return findUsers(match, limit);
}

export async function bridgeStats(
  opts: Parameters<typeof stats>[0],
  part?: Parameters<typeof stats>[1],
) {
  return stats(opts, part);
}

// ─── Triage — direct Anthropic SDK ────────────────────────────────

/** Same shape as the old subprocess-based wrapper so the API route
 *  doesn't change. `timeoutMs` is accepted for backwards compatibility
 *  but ignored — the Anthropic SDK has its own timeout handling. */
export async function bridgeTriage(
  ticket: TicketDetail,
  opts: TriageOptions & { timeoutMs?: number } = {},
): Promise<{ triage: TriageResult }> {
  const triage = await runTriage(ticket, opts);
  return { triage };
}

// ─── Config probe ─────────────────────────────────────────────────

export type BridgeConfig = BugzillaConfig;

export async function getBridgeConfig(): Promise<{
  config: BridgeConfig | null;
  error: string | null;
}> {
  try {
    return { config: getConfig(), error: null };
  } catch (err) {
    return { config: null, error: err instanceof Error ? err.message : String(err) };
  }
}
