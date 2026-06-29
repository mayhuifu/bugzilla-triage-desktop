import { NextRequest, NextResponse } from "next/server";
import { bridgeProducts } from "@/lib/bridge";
import { MOCK_PRODUCTS } from "@/lib/mock-data";
import { cached, CACHE_TTL } from "@/lib/server-cache";
import { withUser } from "@/lib/users/with-user";

export const dynamic = "force-dynamic";

export const GET = withUser(async (req: Request) => {
  const url = new URL(req.url);
  const explicitMock = url.searchParams.get("mock") === "1";
  const fresh = url.searchParams.get("fresh") === "1";
  const MOCK_TYPE_OPTIONS = ["Change_Request", "Work_Package", "Action_Item", "Requirement", "Specification"];
  const MOCK_PRIORITY_OPTIONS = ["P1", "P2", "P3", "P4", "P5"];
  if (explicitMock) {
    return NextResponse.json({ products: MOCK_PRODUCTS, typeOptions: MOCK_TYPE_OPTIONS, priorityOptions: MOCK_PRIORITY_OPTIONS, source: "mock" });
  }
  try {
    // Cached for the session — product list + type/priority fields are effectively static.
    const { products, typeOptions, priorityOptions } = await cached("products", CACHE_TTL.products, fresh, () => bridgeProducts());
    return NextResponse.json({ products, typeOptions, priorityOptions, source: "bugzilla-mcp" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({
      products: MOCK_PRODUCTS,
      typeOptions: MOCK_TYPE_OPTIONS,
      priorityOptions: MOCK_PRIORITY_OPTIONS,
      source: "mock-fallback",
      error: msg,
    });
  }
});
