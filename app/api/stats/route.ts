import { NextRequest, NextResponse } from "next/server";
import { bridgeStats } from "@/lib/bridge";
import { buildMockStats } from "@/lib/mock-data";

export const dynamic = "force-dynamic";
// 14 parallel Bugzilla queries; slow VPN can push past 30s.
export const maxDuration = 90;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const product = url.searchParams.get("product") || undefined;
  const component = url.searchParams.get("component") || undefined;
  const assignee = url.searchParams.get("assignee") || undefined;
  const explicitMock = url.searchParams.get("mock") === "1";

  if (explicitMock) {
    return NextResponse.json({
      ...buildMockStats({ product, component, assignee }),
      source: "mock",
    });
  }

  try {
    const stats = await bridgeStats({ product, component, assignee });
    return NextResponse.json({ ...stats, source: "bugzilla-mcp" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({
      ...buildMockStats({ product, component, assignee }),
      source: "mock-fallback",
      error: msg,
    });
  }
}
