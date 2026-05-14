import { NextRequest, NextResponse } from "next/server";
import { bridgeWhoami } from "@/lib/bridge";
import { MOCK_WHOAMI } from "@/lib/mock-data";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const explicitMock = new URL(req.url).searchParams.get("mock") === "1";
  if (explicitMock) {
    return NextResponse.json({ ...MOCK_WHOAMI, fetchedFrom: "mock" });
  }
  try {
    const me = await bridgeWhoami();
    return NextResponse.json({ ...me, fetchedFrom: "bugzilla-mcp" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({ ...MOCK_WHOAMI, fetchedFrom: "mock-fallback", error: msg });
  }
}
