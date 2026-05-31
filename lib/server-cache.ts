// ─────────────────────────────────────────────────────────────────
// lib/server-cache.ts — tiny in-memory TTL cache for expensive Bugzilla
// reads, shared across requests in the single Next.js server process.
//
// Why: the dashboard front-loads a LOT of Bugzilla REST traffic on every
// visit — /api/stats alone fires 14 parallel count-queries, plus whoami +
// products. On a slow/remote Bugzilla that's many seconds of latency the
// user feels as "the dashboard loads slow," and it re-pays the full cost
// on every navigation back to the dashboard. whoami/products barely change
// within a session and stats tolerate being a minute stale, so memoizing
// them turns repeat dashboard visits from ~16 Bugzilla calls into ~1
// (just the live ticket list).
//
// Design notes:
//   - Single-user desktop app, single server process → a module-level Map
//     IS the entire cache. No Redis, no cross-process concerns.
//   - A monotonic version counter invalidates EVERYTHING at once. The
//     settings route bumps it on save so a changed Bugzilla URL / API key
//     never serves stale data from the old connection.
//   - Only SUCCESSFUL results are cached: `cached()` propagates throws
//     without storing them, so a transient Bugzilla error doesn't get
//     pinned for the whole TTL (the caller's mock-fallback still kicks in).
//   - `fresh=true` bypasses the cache AND refreshes it (the dashboard's
//     Refresh button passes ?fresh=1).
// ─────────────────────────────────────────────────────────────────

import "server-only";

let _version = 0;

/** Invalidate every cached entry. Call after anything that changes which
 *  Bugzilla we talk to or how (settings save). Cheap — just bumps a
 *  counter; stale entries are ignored on next read and overwritten. */
export function bumpServerCacheVersion(): void {
  _version++;
}

interface Entry {
  version: number;
  at: number;
  data: unknown;
}

const store = new Map<string, Entry>();

/** Memoize an async producer under `key` for `ttlMs`. Returns the cached
 *  value when it's still fresh and from the current cache version; else
 *  runs `fn`, stores, and returns. `fresh=true` always re-runs `fn`.
 *
 *  Throws from `fn` propagate and are NOT cached. */
export async function cached<T>(
  key: string,
  ttlMs: number,
  fresh: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (!fresh && hit && hit.version === _version && now - hit.at < ttlMs) {
    return hit.data as T;
  }
  const data = await fn();
  store.set(key, { version: _version, at: now, data });
  return data;
}

/** Common TTLs. Per the dashboard caching policy, data is held for 24h and
 *  only re-fetched when the user hits Refresh (fresh=1) or the entry ages
 *  out — so navigating away (triage / 3GPP spec) and back to the dashboard
 *  reuses the cached counts instead of re-running the Bugzilla queries.
 *  whoami/products are near-static anyway; stats (14 queries) is the
 *  expensive one this protects. Settings-save still invalidates everything
 *  via bumpServerCacheVersion(). */
const DAY_MS = 24 * 60 * 60_000;
export const CACHE_TTL = {
  whoami: DAY_MS,
  products: DAY_MS,
  stats: DAY_MS,
} as const;
