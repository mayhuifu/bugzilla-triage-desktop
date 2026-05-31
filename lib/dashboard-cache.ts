// ─────────────────────────────────────────────────────────────────
// lib/dashboard-cache.ts — client-side snapshot cache for the dashboard.
//
// The dashboard is an app-router page, so navigating to a ticket (triage)
// or the /spec workbench UNMOUNTS it, and navigating back MOUNTS a fresh
// instance with empty React state — which would otherwise re-fetch stats +
// tickets every single time. This module-level cache lives OUTSIDE React,
// so it survives those SPA navigations (it's only cleared on a full page
// reload). On return we hydrate instantly from it — no fetch, no skeleton
// flash.
//
// Policy (per user request):
//   - First load (cache cold) → fetch fresh.
//   - Navigate away + back within 24h → serve from cache, NO re-fetch.
//   - Refresh button → bypass cache, re-fetch, re-cache.
//   - Entry older than 24h → treated as a miss → re-fetch.
//
// Keyed by the request's query string so each filter scope / page size has
// its own entry (switching filters fetches; switching back reuses).
//
// This is a client-only convenience cache. The server-side cache
// (lib/server-cache.ts, also 24h) is the second line: even after a full
// reload clears this, a within-24h stats/whoami/products request is served
// from the server cache without hitting Bugzilla.
// ─────────────────────────────────────────────────────────────────

import type { DashboardStats, TicketSummary } from "./types";

const DAY_MS = 24 * 60 * 60_000;

interface Entry<T> {
  at: number;
  data: T;
}

const statsCache = new Map<string, Entry<DashboardStats>>();
const ticketsCache = new Map<string, Entry<{ tickets: TicketSummary[]; source: string }>>();

function read<T>(map: Map<string, Entry<T>>, key: string): T | null {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= DAY_MS) {
    map.delete(key); // expired → drop so the map doesn't grow unbounded
    return null;
  }
  return hit.data;
}

export function getCachedStats(key: string): DashboardStats | null {
  return read(statsCache, key);
}
export function setCachedStats(key: string, data: DashboardStats): void {
  statsCache.set(key, { at: Date.now(), data });
}

export function getCachedTickets(key: string): { tickets: TicketSummary[]; source: string } | null {
  return read(ticketsCache, key);
}
export function setCachedTickets(key: string, data: { tickets: TicketSummary[]; source: string }): void {
  ticketsCache.set(key, { at: Date.now(), data });
}

/** Drop everything — call when the user forces a global refresh or after a
 *  settings change so a new Bugzilla connection doesn't serve stale data. */
export function clearDashboardCache(): void {
  statsCache.clear();
  ticketsCache.clear();
}
