// ─────────────────────────────────────────────────────────────────
// User search proxy — wraps Bugzilla's `/rest/user?match=<x>` so the
// client-side assignee typeahead can resolve arbitrary engineer
// names/emails without exposing the user's Bugzilla API key.
//
// Behaviour:
//   - `match` is required (and trimmed); empty/short → returns []
//   - 2xx from Bugzilla → `{users: BugzillaUser[]}`
//   - Any failure (auth, network, perm) → `{users: [], error: msg}`
//     with HTTP 502 so the typeahead can show "search failed" without
//     blocking the rest of the dashboard.
// ─────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { bridgeFindUsers } from "@/lib/bridge";
import { withUser } from "@/lib/users/with-user";

export const dynamic = "force-dynamic";

// Bugzilla's user-match requires reasonably specific input — anything
// shorter than 2 chars typically returns hundreds of results and isn't
// useful for a typeahead. Skip the round-trip in that case.
const MIN_MATCH = 2;
// Cap the result size so a generic substring (e.g. "i") doesn't return
// thousands of rows. The UI shows at most ~10 anyway; let the user
// refine if their target isn't in the first batch.
const MAX_RESULTS = 25;

export const GET = withUser(async (req: Request) => {
  const url = new URL(req.url);
  const match = (url.searchParams.get("match") ?? "").trim();
  if (match.length < MIN_MATCH) {
    return NextResponse.json({ users: [] });
  }
  try {
    const { users } = await bridgeFindUsers(match, MAX_RESULTS);
    return NextResponse.json({ users });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 502 (not 500) — the failure is upstream (Bugzilla), not in this
    // app. The typeahead component swallows the body and surfaces a
    // small "search failed" hint to the user.
    return NextResponse.json({ users: [], error: msg }, { status: 502 });
  }
});
