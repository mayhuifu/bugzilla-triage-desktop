// middleware.ts — server-mode setup gate. Page navigations with no bt_session
// cookie are redirected to /setup. Desktop mode (MULTI_USER unset) is a no-op.
// API auth is handled by withUser() (returns 401, not a redirect); this only
// checks cookie PRESENCE (edge runtime can't reach the profiles DB) — withUser
// (Node) is the real authority that validates the session against the store.
import { NextResponse, type NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  if (process.env.MULTI_USER !== "1") return NextResponse.next();
  const { pathname } = req.nextUrl;
  // Let the setup flow, its API, Next internals, and static assets through.
  if (
    pathname === "/setup" ||
    pathname.startsWith("/api/setup") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    /\.[\w]+$/.test(pathname)            // any file with an extension (static)
  ) {
    return NextResponse.next();
  }
  const hasSession = !!req.cookies.get("bt_session")?.value;
  if (hasSession) return NextResponse.next();
  // No session: APIs get 401 (belt-and-suspenders; withUser also 401s), pages
  // redirect to /setup.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "setup required" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/setup";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
