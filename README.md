# Bugzilla AI Triage Dashboard

A polished web app for the umsemi cellular **5G NR RedCap / 4G LTE** engineering
support workflow. It pulls bugs from the company Bugzilla via the existing
`bugzilla-mcp` server + skills, runs structured AI triage using your local
**Claude Code subscription**, lets engineers edit every section, and — only
after explicit human approval — posts the analysis back to Bugzilla through
the same MCP path.

> **Core workflow:**
> Dashboard → Select Ticket → Run AI Triage → Review & Edit → Approve → Submit to Bugzilla via MCP

## What you can do

**Dashboard**
- Filter by **Product** (defaults to U300) and **Component** dropdowns sourced live from Bugzilla.
- Toggle **My Tickets** to scope everything to tickets assigned to your Bugzilla account (auto-detected via `/rest/whoami`, with a `BUGZILLA_LOGIN` env-var fallback for older Bugzilla deployments).
- **Click any status card** (top row: Open Total / Blocker / Critical, Closed Total / Blocker / Critical) — the ticket table below refetches scoped to that bucket. Click again or use the chip’s × to clear.
- **Click any trend card** (bottom row: New filed, New filed B+C, Closed, Closed B+C) — same behavior, scoped to tickets that contributed to that 7-day metric.
- **Last 7 days vs previous 7 days**: each trend card shows Δ and %, color-coded by whether the direction is good or bad for that metric, plus a one-line **trajectory projection** (“Backlog growing · +N/wk (≈ +4N in 4 weeks)” or shrinking/flat).
- **Pagination**: first 25 tickets by default; **Load 25 more** at the bottom of the table extends as needed.
- Stats and tickets **auto-refresh** whenever you change product/component/my-tickets/card filter — both panels show a “refreshing” pill while the new query is in flight.
- Freetext search narrows the visible table client-side without re-querying.

**Ticket detail page**
- Split layout: ticket context (description, comments, history, attachments) on the left, sticky AI triage panel on the right.
- **Drag the divider** between the two columns to resize. Double-click to reset. Width persists across sessions via localStorage. Bounds: 320–900 px on screens ≥1280 px; below that, the layout stacks.
- Chat-style triage workflow: classification → root causes → missing info → next steps → escalation → internal/customer summaries → Bugzilla comment draft. Every field is inline-editable.
- Type a refinement like *“focus on the warm-restart path”* + ⌘+Enter to re-run the AI with your instruction while preserving the same ticket context.
- Approval gate: pick a status transition, tick **I have reviewed every section**, then **Submit to Bugzilla via MCP**. The server refuses to submit if it can’t reach the live Bugzilla — so a triage run that silently fell back to mock data can never be posted.

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
                    │   app/api/{tickets,products,stats,whoami} │
                    └────────────────┬──────────────────────────┘
                                     │ spawn subprocess (uv run)
       ┌─────────────────────────────┼─────────────────────────────┐
       ▼                             ▼                             ▼
┌──────────────────┐        ┌──────────────────┐         ┌──────────────────┐
│ scripts/         │        │ scripts/         │         │ scripts/         │
│ bz_bridge.py     │        │ bz_bridge.py     │         │ triage_llm.py    │
│   search /       │        │   products /     │         │   spawn `claude` │
│   fetch /        │        │   whoami /       │         │   headless       │
│   submit         │        │   stats          │         │                  │
└────────┬─────────┘        └────────┬─────────┘         └────────┬─────────┘
         │ imports                   │ imports                    │ subprocess
         ▼                           ▼                            ▼
   ┌──────────────────────────────────────────────┐         ┌──────────────────┐
   │ ../bugzilla-mcp/skills/bugzilla_analyze.py   │         │  claude CLI      │
   │   • "Analyzed by Claude:" comment prefix     │         │   -p (headless)  │
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
| **bugzilla-mcp** clone | This repo expects `bugzilla-mcp/` either as a peer directory or at `~/bugzilla-mcp/`, containing `.mcp.json` with your Bugzilla credentials. |

## Setup

```bash
# 1. Clone bugzilla-mcp (provides creds + skills) — either as a peer dir
#    or in your home directory, both are auto-detected.
cd ~
git clone https://github.com/mayhuifu/bugzilla-mcp.git

# 2. Clone this repo
git clone https://github.com/mayhuifu/bugzilla-triage-dashboard.git
cd bugzilla-triage-dashboard

# 3. Confirm your bugzilla-mcp/.mcp.json has BUGZILLA_URL and
#    BUGZILLA_API_KEY filled in. No copying into this repo.

# 4. Install JS deps
npm install

# 5. Start the dev server
npm run dev     # → http://localhost:3000
```

If `bugzilla-mcp` lives somewhere unusual, point at it with an env var:

```bash
BUGZILLA_MCP_PATH=/abs/path/to/bugzilla-mcp npm run dev
```

The lookup order (mirrored in `bz_bridge.py` and `lib/bridge.ts`):
1. `$BUGZILLA_MCP_PATH`
2. `../bugzilla-mcp/` (peer to the repo root)
3. `~/bugzilla-mcp/`

Production:
```bash
npm run build && npm start
```

### Required `.mcp.json` shape

`bz_bridge.py` reads the `mcpServers.bugzilla.env` block and pushes those into
the environment for itself and the skills:

```json
{
  "mcpServers": {
    "bugzilla": {
      "env": {
        "BUGZILLA_URL":      "https://ticketing.internal.umsemi.com",
        "BUGZILLA_API_KEY":  "your_api_key_here",
        "BUGZILLA_INSECURE": "true",
        "BUGZILLA_LOGIN":    "your.email@umsemi.com"
      }
    }
  }
}
```

`BUGZILLA_INSECURE=true` disables TLS verification (common for internal
Bugzilla deployments with self-signed certs). When set, `bz_bridge.py`
emits a stderr warning on every invocation so this doesn't ship silently.

`BUGZILLA_LOGIN` is the My-Tickets fallback used when `/rest/whoami`
returns 404 (Bugzilla 5.0 doesn't ship that endpoint by default).

## Data sources & graceful fallback

| Mode | When | Behavior |
|---|---|---|
| **Live** | Bugzilla reachable, bridge succeeds | Real tickets/stats/products via `bz_bridge.py` → REST. Source badge: `live Bugzilla`. |
| **Mock explicit** | `?mock=1` on any endpoint | 15 mock tickets (incl. #16026 frequency-offset bug). Stats and product lists derived from the same mock set. Source: `mock`. |
| **Mock fallback** | Live mode fails (VPN drop, SSL EOF, timeout) | Read endpoints auto-fall back so demos never break. Source: `mock (live backend unavailable)`, banner shows the underlying error. **Submit refuses to mutate** in this state — protects against accidentally posting AI analysis of mock data to a real ticket. |

## File layout

```
bugzilla-triage-dashboard/
├── app/
│   ├── page.tsx                  # Dashboard (queue + status + trends)
│   ├── tickets/[id]/page.tsx     # Split layout: ticket context + AI panel,
│   │                             #   draggable divider, width persisted
│   └── api/
│       ├── tickets/route.ts             # GET   /api/tickets (search + bucket)
│       ├── tickets/[id]/route.ts        # GET   /api/tickets/:id (fetch)
│       ├── tickets/[id]/triage/route.ts # POST  /api/tickets/:id/triage
│       ├── tickets/[id]/triage/followup # POST  refine triage
│       ├── tickets/[id]/submit/route.ts # POST  post comment + transition
│       ├── products/route.ts            # GET   product+component dropdown source
│       ├── whoami/route.ts              # GET   current user (whoami + fallback)
│       └── stats/route.ts               # GET   open/closed snapshot + 7d trends
├── lib/
│   ├── types.ts                  # All types incl. TicketBucket + BUCKET_LABELS
│   ├── bridge.ts                 # Spawns Python bridges, parses RESULT-sentinel JSON
│   └── mock-data.ts              # Mock tickets + mockSearch + buildMockStats
├── components/
│   ├── ui/        Badge, Logo, Toast primitives
│   ├── dashboard/ ProductStatus (clickable cards), TicketTable, TicketFilters
│   ├── detail/    TicketDetailHeader, Description, Comments, Timeline
│   └── triage/    TriageChatPanel (chat-style AI workflow), ChatBubble,
│                  EditableField, StepIndicator
└── scripts/
    ├── bz_bridge.py    # search / fetch / submit / products / whoami /
    │                   #   stats / attachments / config sub-commands
    └── triage_llm.py   # spawns `claude -p` with structured JSON output
```

## API surface

| Endpoint | Verb | Notes |
|---|---|---|
| `/api/tickets` | GET | Search. Params: `product`, `component`, `assignee`, `q`, `limit` (default 25), `status` (repeatable), `severity` (repeatable), `bucket` (see below), `mock`. |
| `/api/tickets/:id` | GET | Full ticket detail + comments + history + attachment metadata. |
| `/api/tickets/:id/triage` | POST | Run AI triage. Query: `model` (defaults to harness default), `mock`. |
| `/api/tickets/:id/triage/followup` | POST | Refine an existing triage with a free-text instruction. |
| `/api/tickets/:id/submit` | POST | Post the approved comment back to Bugzilla. Validates `transitionTo` against `TicketStatus`; requires `resolution` when `transitionTo=RESOLVED`; refuses to fire if `bridgeFetch` can't reach live Bugzilla. |
| `/api/products` | GET | Accessible products + their components. |
| `/api/whoami` | GET | Current API-key holder; falls back to `BUGZILLA_LOGIN`. |
| `/api/stats?product=&component=&assignee=` | GET | 14 parallel `/rest/bug` queries. Returns `{open: {total,blocker,critical}, closed: {…}, trend: {last7d, prev7d, netFlowPerWeek}}`. |

### `bucket` values

The dashboard cards translate to a `bucket` query param. Server-side this
expands to the correct multi-value status/severity filters and (for trend
buckets) date >= bounds.

| Bucket | Server-side filter |
|---|---|
| `open` / `open-blocker` / `open-critical` | `status in OPEN_STATUSES` (+ optional severity) |
| `closed` / `closed-blocker` / `closed-critical` | `status in CLOSED_STATUSES` (+ optional severity) |
| `last7d-filed` / `last7d-filed-bc` | `creation_time >= today-7d` (+ severity in B,C for `-bc`) |
| `last7d-closed` / `last7d-closed-bc` | `status in CLOSED_STATUSES AND last_change_time >= today-7d` (+ severity for `-bc`) |

## Demo script (CEO walkthrough)

1. **Dashboard** — point out the source badge (`live Bugzilla` green vs. `mock` amber) and your signed-in email in the header. The Product Status row shows U300’s 6-cell snapshot (open total / Blocker / Critical, closed total / Blocker / Critical). Below it, the Last 7 days row shows filed/closed counts with Δ vs the previous week and the trajectory projection.
2. **Click the Open Blocker card.** Card glows purple; the ticket table refetches to show the first 25 open blockers; a chip appears: *Filtered by: Open · Blocker [×]*.
3. **Click Load 25 more** — extends to 50. Click any ticket to open the detail page.
4. On the detail page, **drag the vertical divider** between the ticket context and the AI panel — resize to whatever ratio you prefer; the width persists.
5. The AI panel auto-runs (`?autotriage=1`). While Claude classifies the domain (~30–90 s), narrate the ticket context on the left: description, screenshots referenced, comments, status timeline.
6. The AI panel fills in: confidence badge, NR-RF/AT-command domain classification, ranked root causes with falsification tests, missing information, next steps with named owners and pass/fail criteria, escalation recommendation, internal & customer summaries, full Bugzilla comment draft.
7. **Edit a root-cause label** inline — emphasize "AI draft, not final."
8. Type a follow-up: *"focus on the warm-restart path"* → ⌘+Enter to refine.
9. Approval bar: choose status transition (e.g. `IN_ANALYSIS`), tick the approval checkbox, click **Submit to Bugzilla via MCP**.
10. Receipt panel confirms comment ID, posted timestamp, status transition. Toast notification slides in.

## Cost & speed

- **AI step**: ~30–90 s for headless `claude` to return a structured triage for a typical ticket. `?model=haiku` or `?model=sonnet` overrides the harness default.
- **Subscription billing**: charges roll up under your existing Claude Code plan — no separate API key needed.
- **Stats endpoint**: ~2–5 s for 14 parallel `/rest/bug` queries (a 6-thread pool).
- **Caching**: cold start carries ~36k input tokens of Claude Code system prompt (cache miss); subsequent calls within 5 min hit the cache.

## What's deliberately out of scope

- Authentication — assumes deployed behind corporate SSO / VPN
- Per-user saved filters
- Bulk-triage multiple tickets at once
- Inline rendering of attachment images (filename + size shown; the AI is informed of their presence so it can recommend they be read)

These can be added without re-architecting.
