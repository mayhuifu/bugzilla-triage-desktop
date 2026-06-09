// lib/users/with-user.ts — wrap an App Router route handler so it runs as the
// request's logged-in user. Desktop mode (MULTI_USER unset): pure pass-through
// (no session needed) — keeps the single-user build byte-identical. Server mode:
// resolve the bt_session cookie → load the profile → runWithUser() so downstream
// getEffectiveSettings() sees this user; 401 JSON when there's no valid session.
import "server-only";
import { NextResponse } from "next/server";
import { isMultiUser } from "@/lib/settings";
import { resolveSession } from "./store";
import { runWithUser } from "./context";

export const SESSION_COOKIE = "bt_session";

/** Read the session token from a Request's Cookie header. */
export function readSessionCookie(req: Request): string {
  const raw = req.headers.get("cookie") || "";
  const m = raw.match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : "";
}

// App Router handlers are (req) or (req, { params }). Preserve both via rest args.
type RouteHandler = (req: Request, ctx?: any) => Response | Promise<Response>;

/** Gate + contextualize a route handler. */
export function withUser<T extends RouteHandler>(handler: T): T {
  const wrapped = async (req: Request, ctx?: any): Promise<Response> => {
    if (!isMultiUser()) return handler(req, ctx);          // desktop: unchanged
    const user = resolveSession(readSessionCookie(req));
    if (!user) {
      return NextResponse.json(
        { error: "setup required", code: "no_session" },
        { status: 401 },
      );
    }
    return runWithUser(user, () => handler(req, ctx));
  };
  return wrapped as T;
}
