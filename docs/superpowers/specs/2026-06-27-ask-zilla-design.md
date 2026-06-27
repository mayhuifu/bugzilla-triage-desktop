# Ask Zilla — agentic NL search + chat + act (design)

**Status:** built + verified (v0.7.x dev). Brainstormed → built under a "develop + test + fix until done" directive.

## Problem
The dashboard search box did dumb BM25/quicksearch. Users want to ask in plain English ("open blocker tickets older than 90 days with no update in 5 days"), get matching tickets, ask anything (chat), and take actions — all from one place.

## Decisions (from brainstorming)
- **Capability:** search + chat + **act** (not read-only).
- **Write safety:** **always preview + approve** — reads run automatically; every write is a proposal the user approves; nothing is posted until then. Reuses the existing audited endpoints.
- **UI:** a **right-docked "Ask Zilla" panel** (not inline/modal); ticket-search results populate the existing dashboard table (keeps sort/select/bulk-triage).
- **Engine:** a **provider-agnostic, prompt-based tool-use loop** over `runLlmText` — NOT native function-calling — because the shipped default provider is `codex-cli` (a CLI passthrough with no tool API). Works on all four providers.

## Architecture
- `lib/assistant/tools.ts` — tool registry. **Read** tools (`search_tickets`, `get_ticket`, `get_stats`, `search_specs`) execute server-side and degrade to mock data when Bugzilla is unreachable (same contract as the dashboard). **Write** tools (`propose_comment`, `propose_status_change`, `propose_file_ticket`) NEVER execute — they return an `AgentProposal` mapping to an existing endpoint (`/api/tickets/[id]/submit`, `/api/tickets`).
- `lib/assistant/agent.ts` — `runAgent(messages, opts)`: ReAct loop. Each turn the model returns either a ```json {"tool","args"}``` call or a plain-text final answer. `search_tickets` uses **relative-day filters** (`filedMoreThanDaysAgo`, `notUpdatedInDays`, `filedWithinDays`, `updatedWithinDays`) so the model never computes dates; the tool applies date windows client-side (Bugzilla REST date params are lower-bound only). LLM call is injectable for testing.
- `app/api/assistant/route.ts` — `POST` (withUser + per-user rate limit + `maxDuration` 600). Returns `{ answer, tickets, proposals, steps }`. `GET` reports `{ available }`. `?fake=1` (non-prod) swaps a scripted LLM for deterministic loop tests.
- `components/assistant/AskZillaPanel.tsx` — the panel: thread, tool-activity chips, "N results in table" note, and **approval cards** (Approve → POST the proposal to its endpoint). Entry: "✨ Ask Zilla" button on the dashboard filter row → `app/page.tsx` opens the panel; search results set `assistantResults` which overrides the table (with a clear-banner).

## Verified scenarios (live, codex-cli)
1. NL search → correct `search_tickets({severity:Blocker, open, filedMoreThanDaysAgo:90, notUpdatedInDays:5, ...})` + answer + table populate.
2. General chat ("what is RACH used for in 5G NR?") → direct answer, no tool.
3. Action ("draft a comment on #15301 asking for ACLR logs") → `propose_comment` approval card, posts nothing.
4. Error handling: per-step timeout surfaces gracefully.
5. Mock-degradation when Bugzilla is unreachable.

## Notes / follow-ups
- **Provider latency:** codex-cli takes ~50–120s/step (subprocess + gpt-5.5). Switching the provider to `openai-compatible` (DeepSeek — the user's `llmBaseUrl` already points there) would make it near-instant and also supports native tool-calling. The feature works on any provider regardless.
- Scenarios above were verified against **mock** data (live Bugzilla outage during the build); the real path is the same `bridgeSearch` + client-side date filter the dashboard already uses — re-verify against live Bugzilla when reachable.
- Future: eval gate on NL→filter correctness; bidirectional spec/ticket backlinks; multi-step ("search then bulk-triage") leans on the table's existing bulk-triage.
