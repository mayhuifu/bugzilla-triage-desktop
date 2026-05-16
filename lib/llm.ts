// ─────────────────────────────────────────────────────────────────
// LLM triage — Anthropic SDK or OpenAI-compatible SDK.
//
// Replaces scripts/triage_llm.py. The Python version spawned the user's
// local `claude` CLI in headless mode, so it depended on Claude Code being
// installed and authenticated. The standalone Electron app can't assume
// that — non-technical users won't have a Claude Code subscription.
//
// Two provider paths (selected via Settings → AI triage → Provider):
//
//   1. "anthropic"          — @anthropic-ai/sdk + output_config.format with
//                             json_schema, so Anthropic validates the
//                             response against the schema server-side.
//                             baseURL is optional (defaults to the
//                             Anthropic API endpoint).
//
//   2. "openai-compatible"  — openai SDK pointed at a user-supplied baseURL
//                             (LiteLLM, Azure, Ollama, OpenAI, OpenRouter,
//                             vLLM, etc.). Uses response_format json_schema
//                             with strict:true to keep the same parsing
//                             contract.
//
// IMPORTANT: each provider path uses ONLY its native SDK. We never call
// the OpenAI SDK against Anthropic's endpoint or vice-versa — the two
// branches are fully separated below.
// ─────────────────────────────────────────────────────────────────

import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import type { TicketDetail, TriageResult } from "./types";
import { loadSettings } from "./settings";

// Default to Opus 4.7 per Anthropic guidance — the most capable model for
// the kind of multi-layer domain reasoning (RF physics, 3GPP specs,
// falsifiable hypotheses) this triage prompt asks for. Callers can override
// per-request via opts.model.
const DEFAULT_MODEL = "claude-opus-4-7";

// ── Output schema (matches lib/types.ts TriageResult) ────────────
//
// Anthropic's structured-output validator enforces this on the server, so
// the response is guaranteed parseable JSON matching this shape. Any
// schema mismatch becomes a 400 from the API, not a runtime JSON.parse
// crash in our app.

const TRIAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "confidence", "domain", "specReferences", "issueSummary",
    "rootCauses", "missingInformation", "nextSteps",
    "escalationRecommendation", "internalSummary",
    "customerSummary", "bugzillaComment",
  ],
  properties: {
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    domain: {
      type: "string",
      description: "Concise domain classification, e.g. 'NR RF · AT-command surface · band n40 (TDD)'",
    },
    specReferences: {
      type: "array",
      items: { type: "string" },
      description: "Relevant 3GPP / vendor spec clauses",
    },
    issueSummary: { type: "string", description: "1-2 sentence summary of what is wrong" },
    rootCauses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rank", "label", "rationale", "likelihood"],
        properties: {
          rank: { type: "integer" },
          label: { type: "string", description: "Short hypothesis label" },
          rationale: {
            type: "string",
            description: "Why this cause is plausible — must cite evidence or spec",
          },
          likelihood: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
    missingInformation: { type: "array", items: { type: "string" } },
    nextSteps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["owner", "action", "passFail"],
        properties: {
          owner: { type: "string", description: "Email username (before @)" },
          action: { type: "string" },
          passFail: { type: "string", description: "Measurable pass/fail criterion" },
        },
      },
    },
    escalationRecommendation: { type: "string" },
    internalSummary: { type: "string" },
    customerSummary: { type: "string" },
    bugzillaComment: {
      type: "string",
      description:
        "Full 4-layer analysis text. The system will auto-prefix with 'Analyzed by Claude:' on " +
        "submission, so DO NOT include that prefix yourself. Structure: OBSERVED / INFERRED / " +
        "HYPOTHESIS (ranked) / NEXT STEPS (with PASS/FAIL).",
    },
  },
} as const;

// ── System prompt — ported verbatim from scripts/triage_llm.py ────

const SYSTEM_PROMPT = `You are an expert cellular modem engineer performing structured ticket triage
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
- "low" — insufficient info; recommend reporter follow-up before forming hypotheses.`;

// ── User-prompt builder (port of build_user_prompt from Python) ──

function buildUserPrompt(ticket: TicketDetail, followup?: string): string {
  const parts: string[] = [];

  parts.push(`# Ticket #${ticket.id}: ${ticket.summary}`);
  parts.push(
    `Severity: ${ticket.severity} · Priority: ${ticket.priority} · Status: ${ticket.status}`,
  );
  parts.push(`Product/Component: ${ticket.product} / ${ticket.component}`);
  parts.push(`Reporter: ${ticket.reporter} · Assignee: ${ticket.assignee}`);
  if (ticket.customer) parts.push(`Customer/Site: ${ticket.customer}`);
  if (ticket.label) parts.push(`Existing label: ${ticket.label}`);
  if (ticket.keywords?.length) parts.push(`Keywords: ${ticket.keywords.join(", ")}`);
  if (ticket.cc?.length) parts.push(`CC: ${ticket.cc.join(", ")}`);
  parts.push("");
  parts.push("## Description / first comment");
  parts.push(ticket.description || "(empty)");
  parts.push("");

  // Skip first comment — it equals the description by Bugzilla convention.
  const followupComments = ticket.comments.slice(1, 9);
  if (followupComments.length) {
    parts.push(`## Conversation (${ticket.comments.length - 1} subsequent comments)`);
    for (const c of followupComments) {
      const author = c.author.split("@")[0];
      parts.push(`### Comment by ${author} @ ${c.time.slice(0, 10)}`);
      parts.push(c.text.slice(0, 1200));
    }
  }

  const recentHistory = ticket.history.slice(-6);
  if (recentHistory.length) {
    parts.push("");
    parts.push("## Recent state changes");
    for (const h of recentHistory) {
      const who = h.who.split("@")[0];
      for (const ch of h.changes) {
        parts.push(
          `  ${h.when.slice(0, 10)} ${who}: ${ch.field} '${ch.removed}' → '${ch.added}'`,
        );
      }
    }
  }

  if (ticket.attachments.length) {
    parts.push("");
    parts.push(`## Attachments (${ticket.attachments.length})`);
    for (const a of ticket.attachments) {
      parts.push(
        `  · ${a.fileName} (${a.contentType}, ${a.size.toLocaleString()} bytes) by ${a.creator.split("@")[0]}`,
      );
    }
    parts.push(
      "[NOTE: Attachment contents not loaded inline — reason about them from filenames and " +
      "ticket context. Recommend reporter or assignee reads them as a next step if they appear critical.]",
    );
  }

  if (followup) {
    parts.push("");
    parts.push("## User follow-up instruction (apply to your analysis)");
    parts.push(followup);
  }

  parts.push("");
  parts.push("Produce the structured triage JSON now.");
  return parts.join("\n");
}

// ── Public API ────────────────────────────────────────────────────

export interface TriageOptions {
  followup?: string;
  /** Defaults to claude-opus-4-7. Override for cost-tuned deployments. */
  model?: string;
  /** Defaults to process.env.ANTHROPIC_API_KEY. Milestone 3 (settings page)
   *  will pass a user-entered key here from encrypted local storage. */
  apiKey?: string;
}

export async function runTriage(
  ticket: TicketDetail,
  opts: TriageOptions = {},
): Promise<TriageResult> {
  const s = loadSettings();
  const apiKey = opts.apiKey || s.anthropicApiKey;
  if (!apiKey) {
    throw new Error(
      "LLM API key not configured. Open the Settings page (gear icon in the header) " +
      "and enter the API key for your selected provider, then try the triage again.",
    );
  }
  const model = opts.model || s.defaultModel || DEFAULT_MODEL;
  const baseURL = s.llmBaseUrl?.trim() || undefined;
  const userPrompt = buildUserPrompt(ticket, opts.followup);

  const common = { apiKey, baseURL, model, userPrompt, ticketId: ticket.id };
  if (s.llmProvider === "openai-compatible") {
    return runTriageOpenAI(common);
  }
  return runTriageAnthropic(common);
}

// ── Anthropic path ────────────────────────────────────────────────

interface ProviderCallArgs {
  apiKey: string;
  baseURL: string | undefined;
  model: string;
  userPrompt: string;
  ticketId: number;
}

async function runTriageAnthropic(args: ProviderCallArgs): Promise<TriageResult> {
  const { apiKey, baseURL, model, userPrompt, ticketId } = args;
  const client = new Anthropic({ apiKey, baseURL });

  // output_config.format with json_schema makes Anthropic validate the
  // response against the schema server-side, so the first content block
  // is guaranteed to be valid JSON matching TRIAGE_SCHEMA.
  const response = await client.messages.create({
    model,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    output_config: {
      format: { type: "json_schema", schema: TRIAGE_SCHEMA },
    },
  });

  const textBlock = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  if (!textBlock?.text) {
    throw new Error("Anthropic API returned no text block in response");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (err) {
    // Schema enforcement should make this impossible, but guard anyway.
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Anthropic response was not valid JSON despite schema enforcement: ${msg}`);
  }

  return {
    ...parsed,
    ticketId,
    generatedAt: new Date().toISOString(),
    model: response.model || model,
  } as TriageResult;
}

// ── OpenAI-compatible path ────────────────────────────────────────

async function runTriageOpenAI(args: ProviderCallArgs): Promise<TriageResult> {
  const { apiKey, baseURL, model, userPrompt, ticketId } = args;
  // The openai SDK requires *some* baseURL even when pointing at api.openai.com.
  // We let it use its own default when the user left baseURL blank — that's
  // an unusual configuration (the user picked "OpenAI-compatible" but with
  // no URL), but the validateSettings step should have caught it earlier.
  const client = new OpenAI({ apiKey, baseURL });

  // response_format with json_schema + strict:true gives us the same
  // server-side validation guarantee as Anthropic's output_config.format.
  // The schema is identical; only the wire format differs.
  const response = await client.chat.completions.create({
    model,
    max_tokens: 8000,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "triage_result",
        schema: TRIAGE_SCHEMA,
        strict: true,
      },
    },
  });

  const text = response.choices[0]?.message?.content;
  if (!text) {
    throw new Error("OpenAI-compatible API returned no message content");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`OpenAI-compatible response was not valid JSON: ${msg}`);
  }

  return {
    ...parsed,
    ticketId,
    generatedAt: new Date().toISOString(),
    model: response.model || model,
  } as TriageResult;
}
