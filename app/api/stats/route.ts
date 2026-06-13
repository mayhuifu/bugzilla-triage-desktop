import { NextRequest, NextResponse } from "next/server";
import { bridgeStats } from "@/lib/bridge";
import { buildMockStats } from "@/lib/mock-data";
import { cached, CACHE_TTL } from "@/lib/server-cache";
import type { StatsPart, InvolveRole } from "@/lib/bugzilla";
import type { DashboardStats } from "@/lib/types";
import { withUser } from "@/lib/users/with-user";

export const dynamic = "force-dynamic";
// 14 parallel Bugzilla queries (split into 6 core + 8 trend); slow VPN can
// push a full recount past 30s.
export const maxDuration = 90;

/** Slice a full (mock) stats object to the requested part so the mock
 *  fallback matches the shape the client expects for ?part=core|trend. */
function pickPart(full: DashboardStats, part: StatsPart) {
  if (part === "core") {
    const { scope, open, closed, generatedAt } = full;
    return { scope, open, closed, generatedAt };
  }
  if (part === "trend") {
    const { scope, trend, generatedAt } = full;
    return { scope, trend, generatedAt };
  }
  return full;
}

export const GET = withUser(async (req: Request) => {
  const url = new URL(req.url);
  const product = url.searchParams.get("product") || undefined;
  const component = url.searchParams.get("component") || undefined;
  const assignee = url.searchParams.get("assignee") || undefined;
  // "My Tickets" → counts over bugs the user is involved with, scoped to the
  // same roles the list uses (`roles` = subset of assignee/reporter/cc), so the
  // top cards match the filtered list. Default assignee-only when absent.
  const involves = url.searchParams.get("involves") || undefined;
  const involveRoles = (url.searchParams.get("roles") || "").split(",").map(s => s.trim()).filter(Boolean) as InvolveRole[];
  const explicitMock = url.searchParams.get("mock") === "1";
  const fresh = url.searchParams.get("fresh") === "1";
  // The dashboard requests "core" (6 card queries) and "trend" (8 bar
  // queries) separately so the cards paint before the trend bar. Anything
  // else (or absent) computes the full set, preserving back-compat.
  const partParam = url.searchParams.get("part");
  const part: StatsPart = partParam === "core" || partParam === "trend" ? partParam : "all";

  if (explicitMock) {
    return NextResponse.json({
      ...pickPart(buildMockStats({ product, component, assignee, involves, involveRoles }), part),
      source: "mock",
    });
  }

  try {
    // Cached per (scope, part) for 60s — these are the dashboard's most
    // expensive calls. Toggling filters back to a recently-viewed scope, or
    // re-landing on the dashboard, is then instant instead of re-firing the
    // count-queries. Refresh (fresh=1) forces a recount.
    const key = `stats:${part}:${product ?? ""}|${component ?? ""}|${assignee ?? ""}|${involves ?? ""}|${involveRoles.join("+")}`;
    const stats = await cached(key, CACHE_TTL.stats, fresh, () => bridgeStats({ product, component, assignee, involves, involveRoles }, part));
    return NextResponse.json({ ...stats, source: "bugzilla-mcp" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({
      ...pickPart(buildMockStats({ product, component, assignee, involves, involveRoles }), part),
      source: "mock-fallback",
      error: msg,
    });
  }
});
