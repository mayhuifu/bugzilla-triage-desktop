import { NextRequest, NextResponse } from "next/server";
import { bridgeSearch } from "@/lib/bridge";
import { mockSearch } from "@/lib/mock-data";
import { OPEN_STATUSES, CLOSED_STATUSES, type TicketBucket } from "@/lib/types";

export const dynamic = "force-dynamic";

// Expand a bucket id from the dashboard cards into a (status[], severity[],
// dateBound) tuple that the bridge understands. Keeps the translation
// server-side so the same mapping applies regardless of which UI surfaces
// it later.
function expandBucket(bucket: TicketBucket | null): {
  status?: string[]; severity?: string[];
  createdSince?: string; changedSince?: string;
} {
  if (!bucket) return {};

  // Trend buckets — last 7 days filed/closed. Match the windowing the
  // /api/stats endpoint uses so clicking the card returns the tickets
  // that contributed to that count.
  const isoDaysAgo = (n: number) =>
    new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  if (bucket.startsWith("last7d-")) {
    const sevBC = bucket.endsWith("-bc") ? ["Blocker", "Critical"] : undefined;
    if (bucket.startsWith("last7d-filed")) {
      return { severity: sevBC, createdSince: isoDaysAgo(7) };
    }
    // last7d-closed*
    return {
      status: [...CLOSED_STATUSES],
      severity: sevBC,
      changedSince: isoDaysAgo(7),
    };
  }

  // Snapshot buckets — open/closed × all/Blocker/Critical.
  const isOpen = bucket.startsWith("open");
  const baseStatus = isOpen ? [...OPEN_STATUSES] : [...CLOSED_STATUSES];
  if (bucket.endsWith("-blocker")) return { status: baseStatus, severity: ["Blocker"] };
  if (bucket.endsWith("-critical")) return { status: baseStatus, severity: ["Critical"] };
  return { status: baseStatus };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const sp = url.searchParams;
  const product = sp.get("product") || undefined;
  const component = sp.get("component") || undefined;
  const assignee = sp.get("assignee") || undefined;
  const search = sp.get("q") || undefined;
  const limit = parseInt(sp.get("limit") || "25");
  const explicitMock = sp.get("mock") === "1";

  // Bucket wins over the individual status/severity dropdowns when set.
  const bucket = (sp.get("bucket") as TicketBucket | null) || null;
  const expanded = expandBucket(bucket);
  const status = expanded.status ?? (sp.getAll("status").length ? sp.getAll("status") : undefined);
  const severity = expanded.severity ?? (sp.getAll("severity").length ? sp.getAll("severity") : undefined);
  const createdSince = expanded.createdSince;
  const changedSince = expanded.changedSince;

  if (explicitMock) {
    const { tickets, total } = mockSearch({
      product, component, status, severity, assignee, q: search, limit,
      createdSince, changedSince,
    });
    return NextResponse.json({ tickets, total, source: "mock" });
  }

  try {
    const { tickets, total } = await bridgeSearch({
      product, component, status, severity, assignee,
      quicksearch: search, limit, createdSince, changedSince,
    });
    return NextResponse.json({ tickets, total, source: "bugzilla-mcp" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    const fallback = mockSearch({
      product, component, status, severity, assignee, q: search, limit,
      createdSince, changedSince,
    });
    return NextResponse.json({
      tickets: fallback.tickets,
      total: fallback.total,
      source: "mock-fallback",
      error: msg,
    });
  }
}
