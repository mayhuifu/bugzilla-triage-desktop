// app/api/assistant/route.ts — the Ask Zilla agent endpoint.
//
// POST { messages: [{role,content}], context? } → runs the tool-use agent and
// returns { answer, tickets, proposals, steps }. Reads (search/stats/specs) run
// during the loop; writes come back as `proposals` the UI must get the user to
// approve (each maps to an existing audited endpoint). Gated + rate-limited like
// the other LLM routes; works on whatever provider the user configured.
import { NextResponse } from "next/server";
import { withUser } from "@/lib/users/with-user";
import { allowRate, rateEnv } from "@/lib/users/rate-limit";
import { hasConfiguredLlmProvider } from "@/lib/llm";
import { runAgent, type AgentMessage } from "@/lib/assistant/agent";

export const dynamic = "force-dynamic";
export const maxDuration = 600; // agent loops + slow CLI providers (codex-cli ~50-120s/step)

export const GET = withUser(async () => {
  // Lets the UI decide whether to show the Ask box vs fall back to keyword search.
  return NextResponse.json({ available: hasConfiguredLlmProvider() });
});

export const POST = withUser(async (req: Request) => {
  if (!allowRate("assistant", rateEnv("RATE_ASSISTANT_PER_MIN", 20))) {
    return NextResponse.json(
      { error: "Rate limit: too many Ask Zilla requests — try again in a minute." },
      { status: 429 },
    );
  }

  let body: { messages?: unknown; context?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 400 }); }

  const messages = Array.isArray(body.messages) ? body.messages as AgentMessage[] : [];
  if (!messages.length || messages[messages.length - 1]?.role !== "user") {
    return NextResponse.json({ error: "messages must end with a user turn" }, { status: 400 });
  }
  const context = typeof body.context === "string" ? body.context : undefined;

  if (!hasConfiguredLlmProvider()) {
    return NextResponse.json(
      { error: "No AI provider configured — set one in Settings to use Ask Zilla." },
      { status: 400 },
    );
  }

  // Dev-only deterministic test seam: ?fake=1 swaps the LLM for a scripted one so
  // the loop + real tools can be verified without the (slow, nondeterministic)
  // provider. Ignored in production builds.
  const url = new URL(req.url);
  const fake = url.searchParams.get("fake") === "1" && process.env.NODE_ENV !== "production";

  try {
    const result = await runAgent(messages, { context, ...(fake ? { llm: fakeLlm } : {}) });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "agent failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
});

// Scripted LLM for ?fake=1: first turn issues the canonical structured search
// (open blockers filed >90d ago, no update >5d), then wraps up. Deterministically
// exercises the read-tool path + loop without a real model call.
async function fakeLlm(_system: string, transcript: string): Promise<string> {
  if (/TOOL RESULT|TOOL ERROR|PROPOSAL PREPARED/.test(transcript)) {
    return "Here are the matching tickets — shown in the table above.";
  }
  if (/comment|draft|reply/i.test(transcript)) {
    return '```json\n{"tool":"propose_comment","args":{"id":1026,"comment":"Test comment drafted by Ask Zilla (fake mode)."}}\n```';
  }
  return '```json\n{"tool":"search_tickets","args":{"severity":"Blocker","statusGroup":"open","filedMoreThanDaysAgo":90,"notUpdatedInDays":5,"limit":50}}\n```';
}
