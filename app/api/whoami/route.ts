import { NextRequest, NextResponse } from "next/server";
import { bridgeWhoami } from "@/lib/bridge";
import { MOCK_WHOAMI } from "@/lib/mock-data";
import { cached, CACHE_TTL } from "@/lib/server-cache";
import { withUser } from "@/lib/users/with-user";

export const dynamic = "force-dynamic";

export const GET = withUser(async (req: Request) => {
  const url = new URL(req.url);
  const explicitMock = url.searchParams.get("mock") === "1";
  const fresh = url.searchParams.get("fresh") === "1";
  if (explicitMock) {
    return NextResponse.json({ ...MOCK_WHOAMI, fetchedFrom: "mock" });
  }
  try {
    // Cached for the session — whoami doesn't change while the app is open.
    const me = await cached("whoami", CACHE_TTL.whoami, fresh, () => bridgeWhoami());
    return NextResponse.json({ ...me, fetchedFrom: "bugzilla-mcp" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({ ...MOCK_WHOAMI, fetchedFrom: "mock-fallback", error: msg });
  }
});
