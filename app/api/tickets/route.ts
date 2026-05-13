import { NextRequest, NextResponse } from "next/server";
import { bridgeSearch } from "@/lib/bridge";
import { MOCK_SUMMARIES } from "@/lib/mock-data";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const product = url.searchParams.get("product") || undefined;
  const component = url.searchParams.get("component") || undefined;
  const status = url.searchParams.get("status") || undefined;
  const severity = url.searchParams.get("severity") || undefined;
  const assignee = url.searchParams.get("assignee") || undefined;
  const search = url.searchParams.get("q") || undefined;
  const limit = parseInt(url.searchParams.get("limit") || "100");
  const explicitMock = url.searchParams.get("mock") === "1";

  if (explicitMock) {
    return NextResponse.json({
      tickets: MOCK_SUMMARIES,
      total: MOCK_SUMMARIES.length,
      source: "mock",
    });
  }

  try {
    const { tickets, total } = await bridgeSearch({
      product, component, status, severity, assignee,
      quicksearch: search, limit,
    });
    return NextResponse.json({ tickets, total, source: "bugzilla-mcp" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({
      tickets: MOCK_SUMMARIES,
      total: MOCK_SUMMARIES.length,
      source: "mock-fallback",
      error: msg,
    });
  }
}
