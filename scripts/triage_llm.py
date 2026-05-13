#!/usr/bin/env python3
"""
triage_llm.py — Claude Code CLI bridge for AI triage.

Wraps the local `claude` CLI in headless mode (-p, --output-format json,
--json-schema) so the dashboard backend uses the user's existing Claude
Code subscription rather than calling the Anthropic API directly. The
prompt reuses the 4-layer triage scaffold from
bugzilla-mcp/skills/bugzilla_analyze.py and applies the 3GPP standards
context from bugzilla-mcp/skills/domain_3gpp.py when the ticket is
modem-domain.

Input:  full ticket JSON on stdin (same shape as bz_bridge.py fetch output)
Output: TriageResult JSON on stdout (same shape consumed by the Next.js UI)

The JSON schema is enforced by `claude --json-schema` so we never get
malformed output back from the model.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

# Reuse the 3GPP domain classifier if available
BUGZILLA_MCP_PATH = os.environ.get(
    "BUGZILLA_MCP_PATH",
    str(Path(__file__).resolve().parent.parent.parent / "bugzilla-mcp"),
)
sys.path.insert(0, str(Path(BUGZILLA_MCP_PATH) / "skills"))

try:
    from domain_3gpp import classify as classify_3gpp, analysis_preamble as preamble_3gpp
    HAS_3GPP = True
except Exception:
    HAS_3GPP = False


# ── Output schema for the LLM (matches lib/types.ts TriageResult) ────────────
TRIAGE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "confidence", "domain", "specReferences", "issueSummary",
        "rootCauses", "missingInformation", "nextSteps",
        "escalationRecommendation", "internalSummary",
        "customerSummary", "bugzillaComment",
    ],
    "properties": {
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        "domain": {"type": "string", "description": "Concise domain classification, e.g. 'NR RF · AT-command surface · band n40 (TDD)'"},
        "specReferences": {"type": "array", "items": {"type": "string"}, "description": "Relevant 3GPP / vendor spec clauses"},
        "issueSummary": {"type": "string", "description": "1-2 sentence summary of what is wrong"},
        "rootCauses": {
            "type": "array", "minItems": 1, "maxItems": 4,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["rank", "label", "rationale", "likelihood"],
                "properties": {
                    "rank": {"type": "integer", "minimum": 1},
                    "label": {"type": "string", "description": "Short hypothesis label"},
                    "rationale": {"type": "string", "description": "Why this cause is plausible — must cite evidence or spec"},
                    "likelihood": {"type": "string", "enum": ["high", "medium", "low"]},
                },
            },
        },
        "missingInformation": {"type": "array", "items": {"type": "string"}},
        "nextSteps": {
            "type": "array", "minItems": 1, "maxItems": 6,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["owner", "action", "passFail"],
                "properties": {
                    "owner": {"type": "string", "description": "Email username (before @)"},
                    "action": {"type": "string"},
                    "passFail": {"type": "string", "description": "Measurable pass/fail criterion"},
                },
            },
        },
        "escalationRecommendation": {"type": "string"},
        "internalSummary": {"type": "string", "description": "Engineer-facing 2-3 sentence summary"},
        "customerSummary": {"type": "string", "description": "Customer-safe summary — strip internal codenames"},
        "bugzillaComment": {
            "type": "string",
            "description": "Full 4-layer analysis text. The system will auto-prefix with 'Analyzed by Claude:' when posted, so DO NOT include that prefix yourself. Structure: OBSERVED / INFERRED / HYPOTHESIS (ranked) / NEXT STEPS (with PASS/FAIL).",
        },
    },
}


SYSTEM_PROMPT = """You are an expert cellular modem engineer performing structured ticket triage
on a Bugzilla instance for 5G NR RedCap and 4G LTE silicon. Your output must be
a falsifiable, evidence-grounded analysis — not speculation.

CRITICAL RULES:
1. Every observation must be quoted or paraphrased directly from the ticket text / attachments.
2. Every inference must cite a 3GPP spec clause, RF/BB physics, or a compliance helper.
3. Hypotheses must be FALSIFIABLE — each one must come with a test that could disprove it.
4. Next steps must name an owner (use email username before @) and a measurable PASS/FAIL criterion.
5. The bugzillaComment field must follow the 4-layer structure: OBSERVED → INFERRED → HYPOTHESIS → NEXT STEPS.
6. DO NOT include "Analyzed by Claude:" prefix in bugzillaComment — that is added automatically.
7. customerSummary must strip internal codenames (BBIC → baseband subsystem, RFIC → RF subsystem, etc.)
8. For modem/RF tickets, identify the operating band (e.g. n40, B7, n78) and applicable 3GPP spec.

CONFIDENCE GUIDELINE:
- "high" — attachments exist, clear repro steps, domain unambiguous, root cause well-supported.
- "medium" — sparse evidence or ambiguous, but tractable.
- "low" — insufficient info; recommend reporter follow-up before forming hypotheses.

OUTPUT FORMAT (CRITICAL):
Your entire response must be a single JSON object wrapped in ```json … ``` fences.
Do NOT print any prose outside the fences. The schema below is mandatory:

```json
{
  "confidence": "high" | "medium" | "low",
  "domain": "concise classification, e.g. 'NR RF · AT-command surface · band n40 (TDD)'",
  "specReferences": ["TS 38.101-1 §6.4.1", "..."],
  "issueSummary": "1-2 sentence summary",
  "rootCauses": [
    {"rank": 1, "label": "short hypothesis", "rationale": "evidence-based reasoning", "likelihood": "high"|"medium"|"low"}
  ],
  "missingInformation": ["thing 1", "thing 2"],
  "nextSteps": [
    {"owner": "email-prefix", "action": "what to do", "passFail": "measurable success criterion"}
  ],
  "escalationRecommendation": "one line",
  "internalSummary": "engineer-facing 2-3 sentence summary",
  "customerSummary": "customer-safe summary",
  "bugzillaComment": "FULL 4-layer analysis: OBSERVED / INFERRED / HYPOTHESIS / NEXT STEPS"
}
```"""


def build_user_prompt(ticket: dict, followup: str | None = None) -> str:
    """Compose a focused user prompt with all ticket context."""
    parts: list[str] = []

    if HAS_3GPP:
        try:
            tags = classify_3gpp({
                "bug": {
                    "id": ticket["id"],
                    "summary": ticket["summary"],
                    "component": ticket["component"],
                    "product": ticket["product"],
                    "keywords": ticket.get("keywords") or [],
                    "cf_label": ticket.get("label") or "",
                },
                "comments": [{"text": ticket.get("description", "")}],
            })
            if tags:
                parts.append(f"[Domain tags from 3GPP classifier: {', '.join(tags)}]")
        except Exception:
            pass

    parts.append(f"# Ticket #{ticket['id']}: {ticket['summary']}")
    parts.append(f"Severity: {ticket['severity']} · Priority: {ticket['priority']} · Status: {ticket['status']}")
    parts.append(f"Product/Component: {ticket['product']} / {ticket['component']}")
    parts.append(f"Reporter: {ticket['reporter']} · Assignee: {ticket['assignee']}")
    if ticket.get("customer"):
        parts.append(f"Customer/Site: {ticket['customer']}")
    if ticket.get("label"):
        parts.append(f"Existing label: {ticket['label']}")
    if ticket.get("keywords"):
        parts.append(f"Keywords: {', '.join(ticket['keywords'])}")
    if ticket.get("cc"):
        parts.append(f"CC: {', '.join(ticket['cc'])}")
    parts.append("")
    parts.append("## Description / first comment")
    parts.append(ticket.get("description", "") or "(empty)")
    parts.append("")

    comments = ticket.get("comments", [])[1:]  # skip first (== description)
    if comments:
        parts.append(f"## Conversation ({len(comments)} subsequent comments)")
        for c in comments[:8]:
            author = c["author"].split("@")[0]
            parts.append(f"### Comment by {author} @ {c['time'][:10]}")
            parts.append(c["text"][:1200])

    history = ticket.get("history", [])
    if history:
        parts.append("")
        parts.append("## Recent state changes")
        for h in history[-6:]:
            who = h["who"].split("@")[0]
            for ch in h["changes"]:
                parts.append(f"  {h['when'][:10]} {who}: {ch['field']} '{ch['removed']}' → '{ch['added']}'")

    atts = ticket.get("attachments", [])
    if atts:
        parts.append("")
        parts.append(f"## Attachments ({len(atts)})")
        for a in atts:
            parts.append(f"  · {a['fileName']} ({a['contentType']}, {a['size']:,} bytes) by {a['creator'].split('@')[0]}")
        parts.append("[NOTE: Attachment contents not loaded inline — reason about them from filenames and ticket context. Recommend reporter or assignee reads them as a next step if they appear critical.]")

    if followup:
        parts.append("")
        parts.append("## User follow-up instruction (apply to your analysis)")
        parts.append(followup)

    parts.append("")
    parts.append("Produce the structured triage JSON now.")
    return "\n".join(parts)


# ── Call the claude CLI ──────────────────────────────────────────────────────
def run_triage(ticket: dict, followup: str | None = None, *, model: str | None = None, timeout: int = 120) -> dict:
    user_prompt = build_user_prompt(ticket, followup)

    cmd = [
        "claude",
        "-p",  # headless print mode
        "--no-session-persistence",
        "--output-format", "json",
        "--append-system-prompt", SYSTEM_PROMPT,
        "--permission-mode", "bypassPermissions",
        "--disallowedTools", "Bash,Edit,Write,Read,Glob,Grep,Task,WebFetch,WebSearch,TodoWrite",
    ]
    if model:
        cmd += ["--model", model]
    cmd.append(user_prompt)

    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(
            f"claude CLI failed (exit {proc.returncode}). "
            f"stderr: {(proc.stderr or '')[:500]} stdout: {(proc.stdout or '')[:500]}"
        )
    if not proc.stdout or not proc.stdout.strip():
        raise RuntimeError(
            f"claude CLI returned empty stdout (exit {proc.returncode}). "
            f"stderr: {(proc.stderr or '')[:500]}"
        )

    # `--output-format json` wraps the response in metadata
    try:
        envelope = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"claude returned invalid JSON: {e}; stdout: {proc.stdout[:500]}")

    result_str = envelope.get("result", "")
    if not result_str:
        raise RuntimeError(f"claude envelope has no result field. envelope keys: {list(envelope.keys())}")

    # Extract the JSON object from ```json … ``` fences in the model's prose
    import re
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", result_str, re.DOTALL)
    if m:
        json_blob = m.group(1)
    else:
        # Fallback: try to find the first {...} that spans the whole content
        m = re.search(r"(\{[\s\S]*\})", result_str)
        if not m:
            raise RuntimeError(f"no JSON object found in result. result head: {result_str[:300]}")
        json_blob = m.group(1)

    try:
        triage_obj = json.loads(json_blob)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"failed to parse JSON from result: {e}; blob head: {json_blob[:300]}")

    # Add fields the model doesn't produce
    from datetime import datetime, timezone
    triage_obj["ticketId"] = ticket["id"]
    triage_obj["generatedAt"] = datetime.now(timezone.utc).isoformat()
    triage_obj["model"] = envelope.get("model") or model or "claude-code"

    return triage_obj


def main():
    p = argparse.ArgumentParser(description="Run Claude-Code-backed triage on a ticket JSON read from stdin.")
    p.add_argument("--followup", help="Optional follow-up instruction to refine the triage.")
    p.add_argument("--model", help="Model alias (sonnet | opus). Default: harness default.")
    p.add_argument("--timeout", type=int, default=180, help="claude CLI timeout in seconds.")
    args = p.parse_args()

    try:
        ticket_envelope = json.loads(sys.stdin.read())
        ticket = ticket_envelope.get("ticket") or ticket_envelope
        triage = run_triage(ticket, args.followup, model=args.model, timeout=args.timeout)
        print(json.dumps({"triage": triage}))
    except Exception as e:
        print(json.dumps({"error": str(e), "type": type(e).__name__}))
        sys.exit(1)


if __name__ == "__main__":
    main()
