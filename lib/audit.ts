// lib/audit.ts — append-only audit trail of Bugzilla WRITES in server mode.
// One JSON object per line ({ts, user, action, bugId, detail?}) so IT can
// grep/jq it. Desktop mode is exempt (single user, their own key). Auditing
// must never break the write it records — all failures are swallowed.
import "server-only";
import * as fs from "node:fs";
import * as path from "node:path";
import { appDataDir } from "./paths";
import { isMultiUser } from "./settings";
import { getCurrentUser } from "./users/context";

function auditPath(): string {
  return process.env.AUDIT_LOG || path.join(appDataDir(), "audit.log");
}

export function auditBugzillaWrite(
  action: "create" | "comment" | "label" | "status",
  bugId: number | string,
  detail?: string,
): void {
  if (!isMultiUser()) return;
  try {
    const rec = {
      ts: new Date().toISOString(),
      user: getCurrentUser()?.email ?? "(no-session)",
      action,
      bugId: Number(bugId),
      ...(detail ? { detail } : {}),
    };
    fs.mkdirSync(path.dirname(auditPath()), { recursive: true });
    fs.appendFileSync(auditPath(), JSON.stringify(rec) + "\n");
  } catch { /* never block the Bugzilla write */ }
}
