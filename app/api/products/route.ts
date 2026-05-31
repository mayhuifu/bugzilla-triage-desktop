import { NextRequest, NextResponse } from "next/server";
import { bridgeProducts } from "@/lib/bridge";
import { MOCK_PRODUCTS } from "@/lib/mock-data";
import { cached, CACHE_TTL } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const explicitMock = url.searchParams.get("mock") === "1";
  const fresh = url.searchParams.get("fresh") === "1";
  if (explicitMock) {
    return NextResponse.json({ products: MOCK_PRODUCTS, source: "mock" });
  }
  try {
    // Cached for the session — the product list is effectively static.
    const { products } = await cached("products", CACHE_TTL.products, fresh, () => bridgeProducts());
    return NextResponse.json({ products, source: "bugzilla-mcp" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({
      products: MOCK_PRODUCTS,
      source: "mock-fallback",
      error: msg,
    });
  }
}
