#!/usr/bin/env python3
"""
bz_bridge.py — Python bridge for the Bugzilla AI Triage Dashboard.

Reuses the existing bugzilla-mcp helpers (skills/bugzilla_analyze.py,
skills/domain_3gpp.py) so the dashboard inherits all the umsemi workflow
conventions: "Analyzed by Claude:" comment prefix, "Analyzed by Claude"
cf_label, the umsemi-specific resolution vocabulary, and the 4-layer
triage report scaffold.

Reads Bugzilla credentials from the existing bugzilla-mcp .mcp.json
(default: ../bugzilla-mcp/.mcp.json relative to this repo, overridable
via BUGZILLA_MCP_PATH env var).

Sub-commands (each returns one JSON object on stdout):
    search   List tickets matching filters (dashboard table).
    fetch    Full ticket detail + comments + history + attachment metadata.
    submit   Post analysis comment, optionally transition status, always
             apply the "Analyzed by Claude" label.

All commands emit a single line of JSON, or {"error": "..."} on failure.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Optional


# ── Configuration: load creds from the existing bugzilla-mcp .mcp.json ────────
def find_bugzilla_mcp_path() -> Path:
    """Locate the bugzilla-mcp repo so we can read its .mcp.json and import
    its skills/. Order: env var → ../bugzilla-mcp peer dir → ~/bugzilla-mcp."""
    candidates = [
        os.environ.get("BUGZILLA_MCP_PATH"),
        str(Path(__file__).resolve().parent.parent.parent / "bugzilla-mcp"),
        str(Path.home() / "bugzilla-mcp"),
    ]
    for c in candidates:
        if c and Path(c).is_dir() and (Path(c) / ".mcp.json").is_file():
            return Path(c)
    sys.stderr.write(
        "ERROR: cannot locate bugzilla-mcp directory. Set BUGZILLA_MCP_PATH "
        "or clone bugzilla-mcp as a peer directory.\n"
    )
    sys.exit(2)


BUGZILLA_MCP_PATH = find_bugzilla_mcp_path()

# Load .mcp.json once and push env vars expected by the skills
def _load_credentials() -> dict:
    cfg_path = BUGZILLA_MCP_PATH / ".mcp.json"
    cfg = json.loads(cfg_path.read_text())
    env = (cfg.get("mcpServers", {})
              .get("bugzilla", {})
              .get("env", {}))
    for k, v in env.items():
        if v and not os.environ.get(k):
            os.environ[k] = v
    return env

CREDS = _load_credentials()

# Now make the skills importable
sys.path.insert(0, str(BUGZILLA_MCP_PATH))
sys.path.insert(0, str(BUGZILLA_MCP_PATH / "skills"))

# Import skills — they read BUGZILLA_URL/BUGZILLA_API_KEY/BUGZILLA_INSECURE
# from env vars we just set
from skills.bugzilla_analyze import (
    fetch as skill_fetch,
    fetch_attachments as skill_fetch_attachments,
    post as skill_post,
    transition as skill_transition,
    resolve as skill_resolve,
    set_label as skill_set_label,
    trigger as skill_trigger,
    VALID_RESOLUTIONS,
    ANALYSIS_PREFIX,
    CLAUDE_LABEL,
)

import requests
import urllib3
from urllib3.util.retry import Retry
from requests.adapters import HTTPAdapter

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# WARNING: process-wide monkey-patch of `requests`. Safe here because each
# invocation of bz_bridge.py is a fresh `uv run` subprocess that exits after
# emitting one JSON line — there is no long-lived Python process. Do NOT
# import this module from anywhere persistent (a long-running daemon, a
# WSGI worker) without replacing this patch with a Session subclass first.
#
# Monkey-patch requests.Session.send to add transparent retry on SSL EOF /
# connection resets — common on internal-VPN-tunneled Bugzilla instances.
# This applies to skill_fetch / skill_post which also use `requests`.
_RETRY = Retry(
    total=4,
    backoff_factor=0.5,
    status_forcelist=[500, 502, 503, 504],
    allowed_methods=frozenset(["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"]),
)
_ADAPTER = HTTPAdapter(max_retries=_RETRY)
_orig_init = requests.Session.__init__
def _patched_init(self, *a, **kw):
    _orig_init(self, *a, **kw)
    self.mount("https://", _ADAPTER)
    self.mount("http://", _ADAPTER)
requests.Session.__init__ = _patched_init

# Also retry at the module level for the bare requests.get/post calls
import functools
def _with_retry(fn):
    @functools.wraps(fn)
    def wrapper(*a, **kw):
        last_err = None
        for attempt in range(4):
            try:
                return fn(*a, **kw)
            except (requests.exceptions.SSLError, requests.exceptions.ConnectionError) as e:
                last_err = e
                if attempt < 3:
                    import time
                    time.sleep(0.5 * (attempt + 1))
        raise last_err
    return wrapper
requests.get = _with_retry(requests.get)
requests.post = _with_retry(requests.post)
requests.put = _with_retry(requests.put)

BUGZILLA_URL = os.environ.get("BUGZILLA_URL", "")
API_KEY = os.environ.get("BUGZILLA_API_KEY", "")
INSECURE = os.environ.get("BUGZILLA_INSECURE", "true").lower() == "true"
VERIFY = not INSECURE

if INSECURE:
    # Surface this loudly on every invocation so it can't silently ship to
    # an environment that should be verifying certs.
    sys.stderr.write(
        f"[bz_bridge] WARNING: TLS verification disabled (BUGZILLA_INSECURE=true) "
        f"for {BUGZILLA_URL or '<unset>'}\n"
    )


# ── Helpers ──────────────────────────────────────────────────────────────────
OPEN_STATUSES = {"NEW", "IN_PROGRESS", "IN_ANALYSIS", "WAITING_FOR_INFO",
                 "ANALYZED", "INTEGRATED", "IN_VERIFICATION"}
CLOSED_STATUSES = {"RESOLVED", "VERIFIED", "CLOSED"}


def _days_between(iso: str) -> int:
    from datetime import datetime, timezone
    try:
        t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        return max(0, (now - t).days)
    except Exception:
        return 0


def _compute_sla(severity: str, status: str, age_days: int, days_since_update: int) -> str:
    is_open = status not in CLOSED_STATUSES
    if not is_open:
        return "ok"
    high = severity in ("Blocker", "Critical")
    if high and (age_days > 30 or days_since_update > 14):
        return "breach"
    if high and (age_days > 14 or days_since_update > 7):
        return "warn"
    if age_days > 90 or days_since_update > 30:
        return "warn"
    return "ok"


def _normalize_summary(raw: dict) -> dict:
    age = _days_between(raw.get("creation_time", ""))
    upd = _days_between(raw.get("last_change_time", ""))
    severity = raw.get("severity", "Normal")
    status = raw.get("status", "NEW")
    return {
        "id": raw.get("id"),
        "summary": raw.get("summary", ""),
        "product": raw.get("product", ""),
        "component": raw.get("component", ""),
        "customer": raw.get("cf_customer") or None,
        "severity": severity,
        "priority": raw.get("priority", "P3"),
        "status": status,
        "resolution": raw.get("resolution") or None,
        "assignee": raw.get("assigned_to", ""),
        "reporter": raw.get("creator", ""),
        "creationTime": raw.get("creation_time", ""),
        "lastChangeTime": raw.get("last_change_time", ""),
        "ageDays": age,
        "daysSinceUpdate": upd,
        "slaRisk": _compute_sla(severity, status, age, upd),
        "label": raw.get("cf_label") or None,
        "keywords": raw.get("keywords") or None,
    }


# ── Sub-command: search ──────────────────────────────────────────────────────
def cmd_search(args) -> dict:
    params = {
        "api_key": API_KEY,
        "limit": args.limit,
        "offset": args.offset,
        "include_fields": (
            "id,summary,status,resolution,product,component,priority,severity,"
            "assigned_to,creator,creation_time,last_change_time,keywords,cf_label"
        ),
        "order": "last_change_time DESC",
    }
    if args.product: params["product"] = args.product
    if args.component: params["component"] = args.component
    if args.status: params["status"] = args.status
    if args.severity: params["severity"] = args.severity
    if args.assignee: params["assigned_to"] = args.assignee
    if args.quicksearch: params["quicksearch"] = args.quicksearch

    # Retry on intermittent SSL EOFs (common on internal VPN tunnels)
    last_err: Optional[Exception] = None
    for attempt in range(3):
        try:
            r = requests.get(f"{BUGZILLA_URL}/rest/bug",
                             params=params, verify=VERIFY, timeout=30)
            r.raise_for_status()
            bugs = r.json().get("bugs", [])
            return {"tickets": [_normalize_summary(b) for b in bugs], "total": len(bugs)}
        except Exception as e:
            last_err = e
    raise last_err or RuntimeError("search failed")


# ── Sub-command: fetch ───────────────────────────────────────────────────────
def cmd_fetch(args) -> dict:
    ctx = skill_fetch(args.bug_id, related=False)
    bug = ctx["bug"]
    summary = _normalize_summary(bug)
    comments = [
        {
            "id": c.get("id"),
            "count": c.get("count", 0),
            "author": c.get("creator", ""),
            "time": c.get("creation_time", ""),
            "text": c.get("text", ""),
            "isPrivate": bool(c.get("is_private", False)),
        }
        for c in ctx.get("comments", [])
    ]
    history = [
        {
            "who": h.get("who", ""),
            "when": h.get("when", ""),
            "changes": [
                {"field": ch.get("field_name", ""),
                 "removed": str(ch.get("removed", "")),
                 "added": str(ch.get("added", ""))}
                for ch in h.get("changes", [])
            ],
        }
        for h in ctx.get("history", [])
    ]
    attachments = [
        {
            "id": a.get("id"),
            "fileName": a.get("file_name", ""),
            "contentType": a.get("content_type", ""),
            "size": a.get("size", 0),
            "creator": a.get("creator", ""),
            "creationTime": a.get("creation_time", ""),
        }
        for a in ctx.get("attachments", [])
    ]
    return {
        "ticket": {
            **summary,
            "description": comments[0]["text"] if comments else "",
            "cc": bug.get("cc", []),
            "blocks": bug.get("blocks", []),
            "dependsOn": bug.get("depends_on", []),
            "whiteboard": bug.get("whiteboard") or None,
            "url": bug.get("url") or None,
            "comments": comments,
            "history": history,
            "attachments": attachments,
        }
    }


# ── Sub-command: submit ──────────────────────────────────────────────────────
def cmd_submit(args) -> dict:
    """Post an analysis comment using the existing skill (which auto-prefixes
    with 'Analyzed by Claude:' and applies the 'Analyzed by Claude' label).
    Optionally transition status."""
    if args.file:
        body = Path(args.file).read_text()
    elif args.text:
        body = args.text
    else:
        return {"error": "either --file or --text is required"}

    # Use skill_post: prefixes + sets label automatically
    post_result = skill_post(args.bug_id, body, label=True)
    comment_id = post_result.get("id")

    new_status = None
    if args.transition_to:
        if args.transition_to == "RESOLVED" and args.resolution:
            if args.resolution not in VALID_RESOLUTIONS:
                return {"error": f"invalid resolution; valid: {sorted(VALID_RESOLUTIONS)}"}
            skill_resolve(args.bug_id, args.resolution, comment=None, label=False)
            new_status = "RESOLVED"
        else:
            skill_transition(args.bug_id, args.transition_to, comment=None, label=False)
            new_status = args.transition_to

    from datetime import datetime, timezone
    return {
        "success": True,
        "ticketId": args.bug_id,
        "commentId": comment_id,
        "newStatus": new_status,
        "postedAt": datetime.now(timezone.utc).isoformat(),
        "message": f"Posted to Bugzilla via skills.bugzilla_analyze (label='{CLAUDE_LABEL}', prefix='{ANALYSIS_PREFIX}')",
    }


# ── Sub-command: attachments (download base64 content for AI to read) ───────
def cmd_attachments(args) -> dict:
    """Returns base64-decoded attachment contents (subset of attachments).
    Used by the triage step so the LLM can read screenshots/logs."""
    import base64
    atts = skill_fetch_attachments(args.bug_id)
    out = []
    for a in atts:
        # Skip huge binaries to keep response small
        if a["size"] > 5_000_000:
            continue
        out.append({
            "id": a["id"],
            "fileName": a["file_name"],
            "contentType": a["content_type"],
            "size": a["size"],
            "creator": a["creator"],
            "creationTime": a["creation_time"],
            "base64": base64.b64encode(a["data"]).decode("ascii"),
        })
    return {"attachments": out}


# ── Sub-command: config (show resolved credentials so the UI can sanity-check) ─
def cmd_config(args) -> dict:
    return {
        "bugzillaUrl": BUGZILLA_URL,
        "bugzillaMcpPath": str(BUGZILLA_MCP_PATH),
        "insecure": INSECURE,
        "hasApiKey": bool(API_KEY),
        "login": os.environ.get("BUGZILLA_LOGIN", ""),
        "claudeLabel": CLAUDE_LABEL,
        "analysisPrefix": ANALYSIS_PREFIX,
        "validResolutions": sorted(VALID_RESOLUTIONS),
    }


# ── CLI ──────────────────────────────────────────────────────────────────────
def main():
    p = argparse.ArgumentParser(description="Bugzilla bridge for the AI Triage Dashboard.")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("search")
    sp.add_argument("--product")
    sp.add_argument("--component")
    sp.add_argument("--status")
    sp.add_argument("--severity")
    sp.add_argument("--assignee")
    sp.add_argument("--quicksearch")
    sp.add_argument("--limit", type=int, default=100)
    sp.add_argument("--offset", type=int, default=0)

    sp = sub.add_parser("fetch")
    sp.add_argument("bug_id", type=int)

    sp = sub.add_parser("submit")
    sp.add_argument("bug_id", type=int)
    g = sp.add_mutually_exclusive_group(required=True)
    g.add_argument("--file")
    g.add_argument("--text")
    sp.add_argument("--transition-to", dest="transition_to")
    sp.add_argument("--resolution")

    sp = sub.add_parser("attachments")
    sp.add_argument("bug_id", type=int)

    sp = sub.add_parser("config")

    args = p.parse_args()
    handlers = {
        "search": cmd_search, "fetch": cmd_fetch, "submit": cmd_submit,
        "attachments": cmd_attachments, "config": cmd_config,
    }
    try:
        out = handlers[args.cmd](args)
        print("===RESULT===")
        print(json.dumps(out, default=str))
    except Exception as e:
        print("===RESULT===")
        print(json.dumps({"error": str(e), "type": type(e).__name__}))
        sys.exit(1)


if __name__ == "__main__":
    main()
