// lib/assistant/agent.ts — the "Ask Zilla" agent: a provider-agnostic,
// prompt-based tool-use loop. Works on EVERY lib/llm.ts provider (anthropic,
// openai-compatible, claude-cli, codex-cli) because it rides runLlmText (text
// in → text out) instead of native function-calling — important since the
// shipped default provider is codex-cli, which has no tool API.
//
// Protocol: each turn the model returns EITHER a JSON tool call
//   ```json
//   {"tool":"search_tickets","args":{...}}
//   ```
// or a plain-text final answer. Read tools run server-side and feed their
// result back; write tools become approval proposals (never executed here).
import "server-only";
import { runLlmText } from "@/lib/llm";
import {
  AGENT_TOOLS, executeReadTool, buildProposal, isWriteTool, isKnownTool,
  type AgentProposal,
} from "./tools";
import type { TicketSummary } from "@/lib/types";

export interface AgentMessage { role: "user" | "assistant"; content: string }

export interface AgentStep {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  note: string;                       // short status for the UI's activity chip
}

export interface AgentResult {
  answer: string;                     // final assistant text
  tickets: TicketSummary[];           // most-recent search result → drives the table
  proposals: AgentProposal[];         // pending writes awaiting approval
  steps: AgentStep[];                 // tool activity (transparency)
}

export interface RunAgentOptions {
  /** Injectable for tests; defaults to the real multi-provider call. */
  llm?: (system: string, user: string, opts?: { timeoutMs?: number; maxTokens?: number }) => Promise<string>;
  maxSteps?: number;
  /** Extra context appended to the system prompt (e.g. "Current product: U300"). */
  context?: string;
  timeoutMs?: number;
}

function systemPrompt(context?: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const tools = AGENT_TOOLS.map(t => `- ${t.name} (${t.kind}): ${t.description}\n    args: ${t.args}`).join("\n");
  return [
    "You are Zilla Copilot, an assistant embedded in a Bugzilla triage dashboard for a 5G/4G modem engineering team.",
    `Today is ${today}.`,
    context ? context : "",
    "",
    "You can answer general questions directly, OR use tools to query Bugzilla / the 3GPP spec corpus and to PROPOSE changes.",
    "",
    "TOOLS:",
    tools,
    "",
    "PROTOCOL — every turn, output EXACTLY ONE of:",
    "1. A single tool call, as a JSON code block and nothing else:",
    '```json',
    '{"tool":"search_tickets","args":{"severity":"Blocker","statusGroup":"open","filedMoreThanDaysAgo":90,"notUpdatedInDays":5}}',
    '```',
    "2. Your final answer to the user, as plain prose (NO json block).",
    "",
    "RULES:",
    "- For any request to find/list/count tickets, call search_tickets — do not guess from memory.",
    "- Prefer relative-day filters (filedMoreThanDaysAgo, notUpdatedInDays, filedWithinDays, updatedWithinDays) over absolute dates.",
    "- 'older than N days' → filedMoreThanDaysAgo:N. 'no update / not touched in N days' → notUpdatedInDays:N. 'in the last N days' → filedWithinDays/updatedWithinDays:N.",
    "- 3GPP SPEC QUESTIONS ARE GROUNDED, NEVER GENERATED. For ANY question about what a 3GPP spec says — a clause's content, a procedure / field / IE / timer / state / value defined by a spec, \"what does 38.331 say about X\", or the spec meaning of an acronym or term — you MUST call search_specs FIRST and base your answer ONLY on the clauses it returns. Cite the clause for every spec claim, using the citation the tool gives back (e.g. \"per TS 38.331 §5.3.5\").",
    "- NEVER answer a spec question from prior knowledge or training data: spec text changes across releases and must come from the corpus to be correct. If search_specs returns no relevant clause (or reports the corpus may not be installed), tell the user the spec corpus doesn't cover it and that you can't verify it — do NOT fabricate, paraphrase from memory, or guess spec content.",
    "- Search at most 2-3 times (you may vary the query). Once you have the clauses back, answer from them or state plainly that the corpus doesn't cover the exact spec asked — do NOT keep re-searching the same thing.",
    "- After a tool returns, either call another tool or give your final answer. Keep answers concise; the ticket table already shows the rows, so summarize (counts, oldest, notable) rather than relisting every ticket.",
    "- WRITE tools (propose_*) only PROPOSE; tell the user you've prepared it for their approval. Never claim something was posted/filed/changed.",
    "- If a tool errors, explain briefly and suggest a fix; don't loop on the same failing call.",
  ].filter(Boolean).join("\n");
}

/** Pull a tool call out of a model turn, else treat the turn as a final answer. */
export function parseStep(text: string): { tool: string; args: Record<string, unknown> } | { final: string } {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate: string | null = fence ? fence[1].trim() : null;
  if (!candidate) {
    const t = text.trim();
    if (t.startsWith("{") && t.includes('"tool"')) candidate = t;
  }
  if (candidate) {
    try {
      const obj = JSON.parse(candidate) as { tool?: unknown; args?: unknown; final?: unknown };
      if (typeof obj.tool === "string") {
        return { tool: obj.tool, args: (obj.args && typeof obj.args === "object" ? obj.args : {}) as Record<string, unknown> };
      }
      if (typeof obj.final === "string") return { final: obj.final };
    } catch { /* not JSON → final answer */ }
  }
  return { final: text.trim() };
}

export async function runAgent(messages: AgentMessage[], opts: RunAgentOptions = {}): Promise<AgentResult> {
  // Per-step timeout is generous: the CLI providers (codex-cli/claude-cli) spawn
  // a subprocess and routinely take 50-120s per call. 150s avoids spurious
  // timeouts while still bounding a hung subprocess.
  const llm = opts.llm ?? ((sys, usr, o) => runLlmText(sys, usr, { timeoutMs: opts.timeoutMs ?? 150_000, maxTokens: 1500, ...o }));
  const maxSteps = opts.maxSteps ?? 6;
  const system = systemPrompt(opts.context);

  // Flatten the conversation into a transcript we extend as the loop runs.
  let transcript = "CONVERSATION SO FAR:\n" +
    messages.map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n") +
    "\n\nWork on the latest user message now. Respond with one tool call or your final answer.";

  const steps: AgentStep[] = [];
  const proposals: AgentProposal[] = [];
  let tickets: TicketSummary[] = [];

  for (let i = 0; i < maxSteps; i++) {
    const out = await llm(system, transcript);
    const parsed = parseStep(out);
    if ("final" in parsed) {
      return { answer: parsed.final || "(no answer)", tickets, proposals, steps };
    }

    const { tool, args } = parsed;
    if (!isKnownTool(tool)) {
      transcript += `\n\nYou requested unknown tool "${tool}". Available: ${AGENT_TOOLS.map(t => t.name).join(", ")}. Try again or answer the user.`;
      steps.push({ tool, args, ok: false, note: `unknown tool ${tool}` });
      continue;
    }

    try {
      if (isWriteTool(tool)) {
        const proposal = buildProposal(tool, args);
        proposals.push(proposal);
        steps.push({ tool, args, ok: true, note: proposal.title });
        transcript += `\n\nAssistant called ${tool}(${JSON.stringify(args)})\nPROPOSAL PREPARED (awaiting user approval): ${proposal.title}. Do not call this tool again for the same change. Continue or give your final answer.`;
      } else {
        const result = await executeReadTool(tool, args);
        if (result.tickets) tickets = result.tickets;
        steps.push({ tool, args, ok: true, note: summarizeArgs(tool, args) });
        transcript += `\n\nAssistant called ${tool}(${JSON.stringify(args)})\nTOOL RESULT:\n${result.summary}`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "tool failed";
      steps.push({ tool, args, ok: false, note: msg });
      transcript += `\n\nAssistant called ${tool}(${JSON.stringify(args)})\nTOOL ERROR: ${msg}. Do not retry identically.`;
    }
  }

  // Ran out of steps — ask for a wrap-up answer with what we have.
  const wrap = await llm(system, transcript + "\n\nStep budget reached. Give your final answer to the user now based on the results above.")
    .catch(() => "I gathered some results but couldn't fully finish — see the table and any proposals above.");
  return { answer: parseFinal(wrap), tickets, proposals, steps };
}

function parseFinal(text: string): string {
  const p = parseStep(text);
  // If the model emitted yet another tool call at wrap-up, don't surface the raw
  // JSON — give a clean fallback.
  return "final" in p ? p.final : "I gathered the results above — see the table and any proposals.";
}

/** Compact, human-readable description of a tool call for the UI activity chip. */
function summarizeArgs(tool: string, args: Record<string, unknown>): string {
  if (tool === "search_tickets") {
    const bits = [
      args.severity && `severity=${Array.isArray(args.severity) ? args.severity.join("/") : args.severity}`,
      args.statusGroup && `${args.statusGroup}`,
      args.status && `status=${args.status}`,
      args.product && `product=${args.product}`,
      args.component && `component=${args.component}`,
      args.mine && "mine",
      args.filedMoreThanDaysAgo != null && `filed>${args.filedMoreThanDaysAgo}d`,
      args.filedWithinDays != null && `filed≤${args.filedWithinDays}d`,
      args.notUpdatedInDays != null && `stale>${args.notUpdatedInDays}d`,
      args.updatedWithinDays != null && `updated≤${args.updatedWithinDays}d`,
      args.text && `"${args.text}"`,
    ].filter(Boolean);
    return `search ${bits.join(", ") || "all"}`;
  }
  if (tool === "get_ticket") return `read #${args.id}`;
  if (tool === "get_stats") return `stats ${args.product ?? "all"}`;
  if (tool === "search_specs") return `specs "${args.query}"`;
  return tool;
}
