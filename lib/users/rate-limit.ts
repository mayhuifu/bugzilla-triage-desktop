// lib/users/rate-limit.ts — tiny in-memory sliding-window limiter for the
// LLM-spending routes in server mode (≤20 users on one VM → a Map is the
// whole implementation). Desktop mode: always allowed (byte-identical).
import "server-only";
import { isMultiUser } from "@/lib/settings";
import { getCurrentUser } from "./context";

const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

/** True when the current user may proceed; false → caller should 429. */
export function allowRate(bucket: string, maxPerMinute: number): boolean {
  if (!isMultiUser()) return true;
  const who = getCurrentUser()?.email ?? "anon";
  const key = `${bucket}:${who}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= maxPerMinute) { hits.set(key, recent); return false; }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

/** Positive-integer env knob with a default (RATE_TRIAGE_PER_MIN etc.). */
export function rateEnv(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
