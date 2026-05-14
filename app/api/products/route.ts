import { NextRequest, NextResponse } from "next/server";
import { bridgeProducts } from "@/lib/bridge";
import { MOCK_PRODUCTS } from "@/lib/mock-data";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const explicitMock = new URL(req.url).searchParams.get("mock") === "1";
  if (explicitMock) {
    return NextResponse.json({ products: MOCK_PRODUCTS, source: "mock" });
  }
  try {
    const { products } = await bridgeProducts();
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
