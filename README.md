# Bugzilla AI Triage Dashboard

A polished web app for the umsemi cellular **5G NR RedCap / 4G LTE** engineering
support workflow. It pulls bugs from the company Bugzilla via the existing
`bugzilla-mcp` server + skills, runs structured AI triage using your local
**Claude Code subscription**, lets engineers edit every section, and — only
after explicit human approval — posts the analysis back to Bugzilla through
the same MCP path.

> **Core workflow:**
> Dashboard → Select Ticket → Run AI Triage → Review & Edit → Approve → Submit to Bugzilla via MCP

## Why a separate repo?

The `bugzilla-mcp` repo provides the MCP server, REST client, and Python
skills (`bugzilla_analyze.py`, `domain_3gpp.py`) — the data and convention
layer. This repo wraps a Next.js dashboard around them and adds a Claude
Code CLI bridge for the AI step. They're decoupled so the MCP/skills can
keep evolving without dragging UI commits along.

## Architecture

```
                    ┌───────────────────────────────────────────┐
   Browser ─HTTP→   │  Next.js (App Router, server-side routes) │
                    │   app/api/tickets/* …                     │
                    └────────────────┬──────────────────────────┘
                                     │ spawn subprocess
       ┌─────────────────────────────┼─────────────────────────────┐
       ▼                             ▼                             ▼
┌──────────────────┐        ┌──────────────────┐         ┌──────────────────┐
│ scripts/         │        │ scripts/         │         │ scripts/         │
│ bz_bridge.py     │        │ bz_bridge.py     │         │ triage_llm.py    │
│   search /       │        │   submit         │         │   spawn `claude` │
│   fetch          │        │                  │         │   headless       │
└────────┬─────────┘        └────────┬─────────┘         └────────┬─────────┘
         │ imports                   │ imports                    │ subprocess
         ▼                           ▼                            ▼
   ┌──────────────────────────────────────────────┐         ┌──────────────────┐
   │ ../bugzilla-mcp/skills/bugzilla_analyze.py   │         │  claude CLI      │
   │   • "Analyzed by Claude:" comment prefix     │         │   --model haiku  │
   │   • "Analyzed by Claude" cf_label            │         │   --output-format│
   │   • umsemi resolution vocabulary             │         │     json         │
   │   • REST calls with API key from .mcp.json   │         │   (uses your     │
   │ ../bugzilla-mcp/skills/domain_3gpp.py        │         │    Claude Code   │
   │   • NR/LTE/RedCap classification             │         │    subscription) │
   │   • 3GPP R17 spec lookup                     │         │                  │
   └──────────────────────────────────────────────┘         └──────────────────┘
```

**Bugzilla credentials** are read from `../bugzilla-mcp/.mcp.json` automatically.
You don't need to copy keys into this repo. Override the path with
`BUGZILLA_MCP_PATH=/path/to/bugzilla-mcp` if needed.

## Prerequisites

| Tool | Why |
|---|---|
| **Node.js 20+** | Next.js 15 runtime |
| **uv** (Astral) | Python dep management for the bridge scripts. Install: `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| **claude CLI** (Claude Code) | Headless LLM calls. Already installed if you use Claude Code. |
| **bugzilla-mcp** clone | This repo expects `bugzilla-mcp/` as a peer directory containing `.mcp.json` with your Bugzilla credentials. |

## Quick start

```bash
# Clone alongside bugzilla-mcp
cd ~                                                       # so the two repos live as peers
git clone https://github.com/mayhuifu/bugzilla-mcp.git     # provides skills + creds
git clone https://github.com/mayhuifu/bugzilla-triage-dashboard.git
cd bugzilla-triage-dashboard

# Bugzilla creds: handled automatically — bz_bridge.py reads
# ../bugzilla-mcp/.mcp.json. No copying required.

npm install
npm run dev     # → http://localhost:3000
```

Production:
```bash
npm run build && npm start
```

## Data sources & graceful fallback

| Mode | When | Behavior |
|---|---|---|
| **Live** | Bugzilla reachable, bridge succeeds | Real tickets via `bz_bridge.py` → `skills/bugzilla_analyze.py` → REST. Source badge: `bugzilla-mcp`. |
| **Mock explicit** | `?mock=1` on any endpoint | 15 mock tickets (incl. #16026 frequency-offset bug). Source: `mock`. |
| **Mock fallback** | Live mode fails (VPN drop, SSL EOF, timeout) | Auto-falls back to mock so demos never break. Source: `mock-fallback`, warning banner shows the underlying error. |

## File layout

```
bugzilla-triage-dashboard/
├── app/
│   ├── page.tsx                  # Dashboard (triage queue)
│   ├── tickets/[id]/page.tsx     # Split layout: ticket context + sticky AI panel
│   └── api/tickets/
│       ├── route.ts              # GET   /api/tickets               → bz_bridge search
│       ├── [id]/route.ts         # GET   /api/tickets/:id           → bz_bridge fetch
│       ├── [id]/triage/route.ts  # POST  /api/tickets/:id/triage    → bz_bridge fetch + triage_llm
│       ├── [id]/triage/followup  # POST  /api/tickets/:id/triage/followup
│       └── [id]/submit/route.ts  # POST  /api/tickets/:id/submit    → bz_bridge submit
├── lib/
│   ├── types.ts                  # TicketSummary, TicketDetail, TriageResult, …
│   ├── bridge.ts                 # spawns the Python bridges from Next.js
│   └── mock-data.ts              # 15 demo tickets for demo-safe fallback
├── components/
│   ├── ui/        Badge, Logo, Toast primitives
│   ├── dashboard/ StatsBar, TicketTable, TicketFilters
│   ├── detail/    TicketDetailHeader, Description, Comments, Timeline
│   └── triage/    TriagePanel (the editable AI workflow), EditableField
└── scripts/
    ├── bz_bridge.py    # search / fetch / submit / attachments / config
    └── triage_llm.py   # spawns `claude -p` with structured JSON output
```

## Configuration

`bz_bridge.py` auto-discovers `bugzilla-mcp` in this order:

1. `$BUGZILLA_MCP_PATH` (env var)
2. `../bugzilla-mcp/` (peer dir — the default)
3. `~/bugzilla-mcp/`

It reads `.mcp.json` from that directory and sets `BUGZILLA_URL`,
`BUGZILLA_API_KEY`, `BUGZILLA_INSECURE`, `BUGZILLA_LOGIN` for itself
and for the Python skills.

## Demo script (CEO walkthrough)

1. **Dashboard** — point out: source badge (live vs. mock), stats bar (Blockers / Critical / SLA breaches), SLA risk indicators on each row.
2. **Filter Severity = Critical** to surface the queue that matters most.
3. **Click "Triage"** on row #16026 (frequency offset bug). Detail page loads with AI panel auto-running.
4. While Claude classifies the domain (~30–60s for haiku), narrate the ticket context on the left: description, screenshots referenced, comments, status timeline.
5. AI panel fills in: confidence badge, NR-RF/AT-command domain classification, ranked root causes, missing information, next steps with pass/fail criteria, escalation recommendation, internal & customer summaries, full Bugzilla comment draft.
6. **Edit a root-cause label** inline — emphasize "AI draft, not final."
7. Type a follow-up: *"focus on the warm-restart path"* → click **Refine triage**.
8. Approval bar: choose status transition (e.g. `IN_ANALYSIS`), tick the approval checkbox, click **Submit to Bugzilla via MCP**.
9. Receipt panel confirms comment ID, posted timestamp, status transition. Toast notification slides in.

## Cost & speed

- **AI step**: ~15–90 s depending on ticket size and model (`haiku` default, switch to `sonnet` for richer output via `?model=sonnet`).
- **Subscription billing**: charges roll up under your existing Claude Code plan — no separate API key needed.
- **Caching**: cold start carries ~36k input tokens of Claude Code system prompt (cache miss); subsequent calls within 5 min hit the cache.

## What's deliberately out of scope

- Authentication — assumes deployed behind corporate SSO / VPN
- Per-user saved filters
- Bulk-triage multiple tickets at once
- Inline rendering of attachment images (filename + size shown; the AI is informed of their presence so it can recommend they be read)

These can be added without re-architecting.
