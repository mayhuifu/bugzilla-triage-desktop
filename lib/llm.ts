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
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";

import type { TicketDetail, TriageResult, SpecExcerpt } from "./types";
import { loadSettings, type LlmProvider } from "./settings";
import { lookupClause, corpusHasSpec, type RetrievedClause } from "./corpus/retriever";
import { getCorpusDb, getFigureImageBlob } from "./corpus/store";
import { attachments as fetchAttachments } from "./bugzilla";

/** Classify why a lookupClause() call returned null. The UI uses this to
 *  show a clear "spec not in corpus" / "clause not found" chip instead of
 *  a generic [ai paraphrase] tag with no explanation. */
function lookupReasonFor(reference: string): "spec_not_curated" | "clause_not_found" | "no_corpus" {
  if (!getCorpusDb()) return "no_corpus";
  // Extract spec number from the model's citation (e.g. "38.304" out of
  // "3GPP TS 38.304 §5.2.4.5"). If we can't parse, treat as
  // "clause_not_found" — the spec name is missing/malformed.
  const m = reference.match(/(?:TS|TR)\s+(\d+\.\d+(?:-\d+)?)/i);
  if (!m) return "clause_not_found";
  return corpusHasSpec(m[1]) ? "clause_not_found" : "spec_not_curated";
}

// Default to Opus 4.7 per Anthropic guidance — the most capable model for
// the kind of multi-layer domain reasoning (RF physics, 3GPP specs,
// falsifiable hypotheses) this triage prompt asks for. Callers can override
// per-request via opts.model.
const DEFAULT_MODEL = "claude-opus-4-7";

// ── Image-attachment ingestion (vision-capable providers only) ────
//
// When the ticket has image attachments AND the configured provider/model
// supports vision input, fetch the base64 bytes from Bugzilla and pass
// them as image content blocks alongside the text prompt. Otherwise the
// images are skipped and the model only sees their metadata (filename,
// content-type, byte size) the way it always did.
//
// The capability check is conservative: providers / models we KNOW
// support vision get true, everything else gets false. DeepSeek's chat
// endpoint does NOT support vision (only the separate `deepseek-vl2`
// model does, and that's not what users hit via the chat-completions
// URL), so it falls through to false and images are never fetched.

const IMAGE_MIME = /^image\/(png|jpeg|jpg|gif|webp)$/i;
// Per-call cap. Anthropic accepts 100 images per request and the OpenAI
// SDK accepts more, but cost + latency grow linearly. Eight is enough to
// cover most "spectrum analyser screenshot + EVM plot + AT-command log"
// triage scenarios without burning ~$0.10 of vision tokens on a ticket.
const MAX_INLINE_IMAGES = 8;

/** True when the (provider, model) combination accepts image content
 *  blocks alongside the user-prompt text. False (default) means we skip
 *  the attachment fetch entirely — saves a round-trip and avoids burning
 *  bandwidth on bytes we'd just throw away. */
function providerSupportsVision(provider: LlmProvider, model: string): boolean {
  if (provider === "anthropic") return true;          // all Claude 3.x / 4.x
  // claude-cli routes through `claude -p` which takes a positional text
  // prompt; passing images requires saving to a tmp dir and referencing
  // via --file, which adds an extra parse layer. Deferred to a follow-up
  // — for now the CLI path skips images and reports them as metadata
  // only, same as the pre-vision behaviour.
  if (provider === "claude-cli") return false;
  // codex-cli takes images natively via the `-i / --image <FILE>` flag
  // on `codex exec`. We save each attachment to a tmp file and pass the
  // path through — see runTriageCodexCli for the plumbing.
  if (provider === "codex-cli") return true;
  if (provider === "openai-compatible") {
    const m = model.toLowerCase();
    // OpenAI vision-capable families
    if (/^gpt-4o/.test(m)) return true;
    if (/^gpt-4-turbo/.test(m)) return true;        // 2024+ vision-enabled
    if (/^gpt-4-vision/.test(m)) return true;
    if (/^o1|^o3|^o4/.test(m)) return true;         // newer reasoning models
    // Anthropic-via-proxy (some users route Claude through LiteLLM / a
    // corporate gateway under llmProvider="openai-compatible").
    if (/^claude-/.test(m)) return true;
    // Qwen-VL or any model with "vl" / "vision" in the name.
    if (/-vl(\b|-|$)|vision/i.test(m)) return true;
    // DeepSeek chat / r1 / coder — explicitly NOT vision on the chat
    // endpoint. Per user request: don't read images for these.
    if (/^deepseek/.test(m)) return false;
    // Unknown openai-compatible model — conservative default: no vision.
    // The Settings page can warn if the user wants to change this.
    return false;
  }
  return false;
}

/** A single image to inline into the user message. base64 is already
 *  decoded out of Bugzilla's REST envelope by `fetchAttachments`. */
interface InlineImage {
  fileName: string;
  /** Canonical MIME type — `image/png`, `image/jpeg`, `image/gif`, `image/webp`. */
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  base64: string;
}

// ── PDF attachments ───────────────────────────────────────────────
//
// Two paths depending on the provider:
//
//   1. Anthropic — pass the raw PDF bytes as a `document` content block.
//      Claude reads the PDF natively (text + visual layout + diagrams);
//      this is the highest-fidelity path. 32 MB / 100 pages per file
//      per Anthropic's docs.
//
//   2. Everyone else (OpenAI-compatible, claude-cli) — extract page text
//      server-side via pdfjs-dist and inline it into the user prompt as
//      a quoted block. Loses figures/charts but works on every model.
//      DeepSeek's chat endpoint has no native PDF support, so this path
//      is what makes "PDF triage on DeepSeek" possible at all.
//
// Provider-capability check: only Anthropic's official SDK + endpoint
// accepts `document` blocks. OpenAI-compatible proxies that happen to
// front Claude (LiteLLM etc.) often don't pass them through correctly,
// so we DON'T try to route Claude-via-proxy onto the document path —
// we just text-extract for the OpenAI-compatible branch regardless of
// the underlying model name.

const PDF_MIME = /^application\/pdf$/i;
const MAX_PDFS_NATIVE = 5;
const MAX_PDFS_TEXT = 5;
/** Per-PDF text-extraction cap. Most engineering PDFs are 50-300 KB of
 *  text — 50 KB keeps the prompt manageable while still capturing the
 *  meat of a typical 3GPP CR or test report. */
const PDF_TEXT_CHARS_PER_FILE = 50_000;
/** Per-triage total PDF text cap. Five 50 KB PDFs would be 250 KB, which
 *  is fine in Claude context but tight in DeepSeek's 64K-token window.
 *  Hard ceiling at 200 KB total. */
const PDF_TEXT_CHARS_TOTAL = 200_000;
const PDF_TEXT_PAGE_LIMIT = 100;

/** True when the provider accepts native PDF document content blocks.
 *  Anthropic only — see comment above for why we don't enable this for
 *  Claude-via-OpenAI-proxy. */
function providerSupportsNativePdf(provider: LlmProvider): boolean {
  return provider === "anthropic";
}

/** A PDF passed natively to the model (Anthropic path). */
interface InlinePdf {
  fileName: string;
  base64: string;
}

/** A PDF whose text content has been extracted server-side (every
 *  other provider). Tagged with page count and a truncation marker so
 *  the model knows what it's looking at. */
interface ExtractedPdfText {
  fileName: string;
  text: string;
  numPages: number;
  truncatedAt: number | null;   // page number where text was cut off, or null
}

/** Fetch the PDF attachments for a ticket. Returns either native-pass
 *  payloads (Anthropic) or text-extracted ones (everyone else),
 *  depending on `nativeSupported`. Bytes come from the same Bugzilla
 *  REST call used for images, so callers should ideally batch the
 *  fetch — but the second call is cheap enough that we accept it for
 *  code clarity. */
async function loadPdfAttachments(
  ticket: TicketDetail,
  nativeSupported: boolean,
): Promise<{ nativePdfs: InlinePdf[]; extractedTexts: ExtractedPdfText[] }> {
  // Pre-filter on metadata so we skip the second Bugzilla call when
  // there are no PDFs.
  const hasAnyPdf = ticket.attachments.some(a => PDF_MIME.test(a.contentType));
  if (!hasAnyPdf) return { nativePdfs: [], extractedTexts: [] };

  let full: Awaited<ReturnType<typeof fetchAttachments>>["attachments"] = [];
  try {
    full = (await fetchAttachments(ticket.id)).attachments;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[triage] PDF attachment fetch failed (continuing without PDFs):`, err);
    return { nativePdfs: [], extractedTexts: [] };
  }

  const pdfRows = full.filter(a => PDF_MIME.test(a.contentType) && a.base64);

  if (nativeSupported) {
    const nativePdfs: InlinePdf[] = pdfRows
      .slice(0, MAX_PDFS_NATIVE)
      .map(a => ({ fileName: a.fileName, base64: a.base64 }));
    return { nativePdfs, extractedTexts: [] };
  }

  // Text-extraction path. Extract page text per file with per-file and
  // per-triage caps; gracefully skip files whose extraction fails (a
  // password-protected or scanned-only PDF returns near-empty text and
  // we surface that to the model as `[no extractable text]`).
  const extractedTexts: ExtractedPdfText[] = [];
  let usedChars = 0;
  for (const a of pdfRows.slice(0, MAX_PDFS_TEXT)) {
    if (usedChars >= PDF_TEXT_CHARS_TOTAL) break;
    const remaining = PDF_TEXT_CHARS_TOTAL - usedChars;
    const perFileCap = Math.min(PDF_TEXT_CHARS_PER_FILE, remaining);
    try {
      const result = await extractPdfText(a.base64, perFileCap);
      extractedTexts.push({
        fileName: a.fileName,
        text: result.text,
        numPages: result.numPages,
        truncatedAt: result.truncatedAt,
      });
      usedChars += result.text.length;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[triage] PDF extraction failed for ${a.fileName}:`, err);
      extractedTexts.push({
        fileName: a.fileName,
        text: "[extraction failed — PDF may be scanned-only, password-protected, or corrupt]",
        numPages: 0,
        truncatedAt: null,
      });
    }
  }
  return { nativePdfs: [], extractedTexts };
}

/** Extract page text from a base64-encoded PDF using pdfjs-dist. Caps
 *  at PDF_TEXT_PAGE_LIMIT pages and `maxChars` characters total. The
 *  legacy build is used because the modern build assumes a browser
 *  worker; the legacy build runs in pure Node. */
async function extractPdfText(
  base64: string,
  maxChars: number,
): Promise<{ text: string; numPages: number; truncatedAt: number | null }> {
  // Dynamic import — pdfjs is a heavy dep and we only want it loaded
  // when a ticket actually has PDFs to read. Also keeps it out of the
  // Next.js bundle graph (see serverExternalPackages in next.config.mjs).
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(Buffer.from(base64, "base64"));
  // Hardened defaults — we're parsing untrusted PDFs from Bugzilla
  // tickets. v5 removed the legacy `isEvalSupported` knob (eval is no
  // longer used by pdfjs internals at all); we still disable system-font
  // lookup and CSS @font-face so a malicious PDF can't probe the host
  // filesystem.
  const doc = await pdfjsLib.getDocument({
    data,
    useSystemFonts: false,
    disableFontFace: true,
  }).promise;

  const parts: string[] = [];
  let totalChars = 0;
  let truncatedAt: number | null = null;
  const pageLimit = Math.min(doc.numPages, PDF_TEXT_PAGE_LIMIT);
  for (let i = 1; i <= pageLimit; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      // pdfjs returns a union of TextItem | TextMarkedContent — only
      // TextItem has the `.str` field. Filter the rest out.
      .map(item => ("str" in item ? (item as { str: string }).str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (pageText) {
      const block = `[Page ${i}]\n${pageText}`;
      if (totalChars + block.length > maxChars) {
        // Truncate this page at the boundary that fits, then stop.
        const room = Math.max(0, maxChars - totalChars - 20);
        if (room > 50) parts.push(block.slice(0, room) + "…");
        truncatedAt = i;
        break;
      }
      parts.push(block);
      totalChars += block.length;
    }
  }
  if (!truncatedAt && pageLimit < doc.numPages) {
    truncatedAt = pageLimit;
  }
  return { text: parts.join("\n\n"), numPages: doc.numPages, truncatedAt };
}

/** Fetch the image attachments for a ticket as base64 inline data.
 *  Returns an empty array when the ticket has no image-typed attachments
 *  (avoids the Bugzilla round-trip), when the configured provider doesn't
 *  support vision, or when the fetch itself fails (graceful degrade —
 *  triage still runs on text alone). */
async function loadImageAttachments(ticket: TicketDetail): Promise<InlineImage[]> {
  // Pre-filter on metadata we already have. If nothing looks like an
  // image we skip the second REST call entirely.
  const hasAnyImage = ticket.attachments.some(a => IMAGE_MIME.test(a.contentType));
  if (!hasAnyImage) return [];

  try {
    const { attachments: full } = await fetchAttachments(ticket.id);
    const images: InlineImage[] = [];
    for (const a of full) {
      if (images.length >= MAX_INLINE_IMAGES) break;
      if (!IMAGE_MIME.test(a.contentType)) continue;
      if (!a.base64) continue;
      // Normalize "image/jpg" → "image/jpeg" so Anthropic accepts it.
      let mt = a.contentType.toLowerCase();
      if (mt === "image/jpg") mt = "image/jpeg";
      if (mt !== "image/png" && mt !== "image/jpeg" && mt !== "image/gif" && mt !== "image/webp") {
        continue;
      }
      images.push({ fileName: a.fileName, mediaType: mt as InlineImage["mediaType"], base64: a.base64 });
    }
    return images;
  } catch (err) {
    // Don't let a Bugzilla hiccup block the whole triage — fall back to
    // text-only and surface the warning in the server log.
    // eslint-disable-next-line no-console
    console.warn(`[triage] image attachment fetch failed (continuing without vision):`, err);
    return [];
  }
}

// Per-triage cap on the number of corpus figure images injected as
// vision content blocks. Four retrieved clauses × ~3 figures each
// would already be 12 images; we cap at 6 to leave headroom for the
// ticket attachments and to keep token cost predictable on a long
// triage prompt.
const MAX_CORPUS_FIGURE_IMAGES = 6;

/** Walk the retrieved clauses, pull rasterizable figure blobs out of
 *  the corpus, and return them as `InlineImage[]` ready to inject
 *  alongside ticket attachments. SVG figures are intentionally
 *  skipped: neither the Anthropic nor OpenAI vision endpoints accept
 *  SVG natively, and rasterising server-side adds a heavy dep we
 *  haven't budgeted. The SpecDrawer still renders SVGs in the UI
 *  (browser does it natively) — the LLM just doesn't see them. */
function loadCorpusFigureImages(
  retrievedClauses: RetrievedClause[],
): InlineImage[] {
  const out: InlineImage[] = [];
  if (!getCorpusDb()) return out;     // corpus not installed → no figures
  for (const c of retrievedClauses) {
    if (!c.figureImages?.length) continue;
    for (const meta of c.figureImages) {
      if (out.length >= MAX_CORPUS_FIGURE_IMAGES) return out;
      // Only ingest formats the vision endpoints accept. SVG and any
      // unknown MIME falls through to the SpecDrawer-only path.
      const accepted: Record<string, InlineImage["mediaType"]> = {
        "image/png": "image/png",
        "image/jpeg": "image/jpeg",
        "image/jpg": "image/jpeg",
        "image/gif": "image/gif",
        "image/webp": "image/webp",
      };
      const mt = accepted[meta.mimeType.toLowerCase()];
      if (!mt) continue;
      const blob = getFigureImageBlob(c.clauseId, meta.figureId);
      if (!blob) continue;
      const base64 = blob.data.toString("base64");
      out.push({
        // Synthesise a filename so the prompt manifest can reference it.
        // The figureId is composite ("38.331#5.3.5.1/Figure-5.3.5-1");
        // shortening to just the figure label keeps the manifest tidy.
        fileName: `${c.citation} ${meta.figureId.split("/").pop() ?? meta.figureId}`,
        mediaType: mt,
        base64,
      });
    }
  }
  return out;
}

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
    "confidence", "domain", "specReferences", "specExcerpts", "issueSummary",
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
      description: "Relevant 3GPP / vendor spec clauses, e.g. '3GPP TS 38.211 §6.1.4'",
    },
    specExcerpts: {
      type: "array",
      description:
        "ONE entry per spec clause in specReferences when known. Each entry has the " +
        "clause string and a SHORT 1-sentence paraphrase (≤ 25 words, ≤ 160 chars) of " +
        "what that clause specifies. Brevity matters — the summary is rendered into " +
        "the CLASSIFICATION header of the Bugzilla comment, where a long paraphrase " +
        "buries the model's own analysis. Don't repeat the full clause text, don't " +
        "quote, don't enumerate sub-bullets. If you don't know a clause well enough " +
        "to summarize confidently, OMIT that entry rather than guess. Empty array " +
        "is fine when no specs are cited.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["clause", "summary"],
        properties: {
          clause: { type: "string", description: "Matches one of the strings in specReferences" },
          summary: {
            type: "string",
            description:
              "ONE sentence, ≤ 25 words, ≤ 160 chars. What this clause specifies — " +
              "no quoting, no sub-bullets, no padding adverbs.",
          },
        },
      },
    },
    issueSummary: {
      type: "string",
      description: "1-2 sentence summary of what is wrong. ≤ 40 words total.",
    },
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
        "JUST the 4-layer analysis body. Structure: OBSERVED / INFERRED / HYPOTHESIS " +
        "(ranked) / NEXT STEPS (with PASS/FAIL). DO NOT include 'Analyzed by AI Triage " +
        "Bot:' prefix — added automatically on submit. DO NOT include a CLASSIFICATION " +
        "section — the system prepends one automatically from confidence/domain/" +
        "specReferences/specExcerpts. Start directly with 'OBSERVED:'. " +
        "BREVITY IS LOAD-BEARING: every bullet ≤ 25 words / one tight line. " +
        "OBSERVED 3-6 bullets max, INFERRED 2-4, HYPOTHESIS at most 3 (label + 1-line " +
        "rationale + 1-line falsification test), NEXT STEPS ≤ 4 owners (owner / action / " +
        "pass-fail on short lines). No padding adverbs, no restating the ticket verbatim, " +
        "no multi-clause sentences within a bullet.",
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
5. The bugzillaComment field must follow the 4-layer structure: OBSERVED → INFERRED → HYPOTHESIS → NEXT STEPS. Start the text with "OBSERVED:". DO NOT include a CLASSIFICATION header — the system prepends one automatically from the structured fields (confidence, domain, specReferences, specExcerpts).
6. DO NOT include "Analyzed by AI Triage Bot:" prefix in bugzillaComment — that is added automatically.
7. customerSummary must strip internal codenames (BBIC → baseband subsystem, RFIC → RF subsystem, etc.)
8. For modem/RF tickets, identify the operating band (e.g. n40, B7, n78) and applicable 3GPP spec.
9. For each 3GPP / vendor spec clause you cite in specReferences, ALSO add an entry to specExcerpts giving a SHORT 1-sentence paraphrase (≤ 25 words, ≤ 160 characters) of what that clause specifies. Use your training-data knowledge of the spec. The summary is rendered into the CLASSIFICATION header of the Bugzilla comment, so brevity matters — don't repeat the full clause text, don't quote, and don't enumerate sub-bullets. If a clause is too obscure for you to summarize confidently, omit it from specExcerpts (don't fabricate).

BREVITY (load-bearing — the comment is read in a noisy ticket queue, not as a paper):
10. Every bullet in OBSERVED / INFERRED / HYPOTHESIS / NEXT STEPS must be ONE tight line, ≤ 25 words. State the fact, not the narrative.
11. NO padding adverbs ("clearly", "obviously", "essentially", "as can be seen", "it should be noted"). NO restating ticket text verbatim — paraphrase to the smallest set of facts that carries the inference.
12. OBSERVED: 3-6 bullets max. Each one fact pulled from the ticket / log / image / PDF, not a re-summary of the whole ticket.
13. INFERRED: 2-4 bullets max. Each links one OBSERVED fact to a spec clause or physics rule. No "this is consistent with…" hedging.
14. HYPOTHESIS: at most 3 ranked items. Each: short label + one-line rationale + one-line falsification test. Total ≤ 60 words per hypothesis including the test.
15. NEXT STEPS: ≤ 4 owners. Each: owner / action / pass-fail on its own short line. No multi-clause sentences.

CONFIDENCE GUIDELINE:
- "high" — attachments exist, clear repro steps, domain unambiguous, root cause well-supported.
- "medium" — sparse evidence or ambiguous, but tractable.
- "low" — insufficient info; recommend reporter follow-up before forming hypotheses.`;

// ── User-prompt builder (port of build_user_prompt from Python) ──

function buildUserPrompt(
  ticket: TicketDetail,
  followup?: string,
  retrievedClauses?: RetrievedClause[],
): string {
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

  // 3GPP RAG context — top-K BM25 hits over the local Rel-17 corpus.
  // EARLIER VERSION (v0.1.6/v0.1.7) framed these as "CANDIDATE references —
  // cite ONLY when genuinely relevant" and "do not feel obliged to cite every
  // candidate". On DeepSeek that phrasing was too restrictive: when BM25
  // returned tangentially-related clauses (common when the ticket text uses
  // vendor-specific commands like AT#CRFTXSTART that don't exist in 3GPP),
  // the model interpreted the rule as "cite only from this list", saw nothing
  // applicable, and emitted an empty specReferences[] — losing the training-
  // data citations it would have produced without RAG. This new framing
  // makes the retrieved clauses ADDITIVE: useful when they fit, ignored when
  // they don't, with explicit permission (and reminder per CRITICAL RULE #2)
  // to cite training-data clauses anyway.
  if (retrievedClauses && retrievedClauses.length > 0) {
    parts.push("## Possibly-relevant 3GPP clauses (auto-retrieved from local Rel-17 corpus)");
    parts.push("");
    parts.push("These were surfaced by a keyword search over the ticket text. Treat them");
    parts.push("as ADDITIONAL evidence you can draw on alongside your training-data");
    parts.push("knowledge of 3GPP — NOT as a constrained list.");
    parts.push("");
    parts.push("How to use them:");
    parts.push("  - When a retrieved clause genuinely supports an inference, cite it in");
    parts.push("    specReferences using its full canonical form (e.g. \"3GPP TS 38.211 §6.1.4\").");
    parts.push("  - When the retrieved set doesn't fit the ticket, FEEL FREE to cite OTHER");
    parts.push("    clauses you know from training (e.g. for a frequency-error ticket the");
    parts.push("    UE transmit accuracy requirement in TS 38.101-1 §6.5.1, even though");
    parts.push("    that clause isn't listed below).");
    parts.push("  - Empty specReferences is acceptable only when the ticket is genuinely");
    parts.push("    non-3GPP (a build tooling issue, internal-vendor-API bug, etc.).");
    parts.push("    Per CRITICAL RULE #2, modem/RF tickets should cite at least one clause.");
    parts.push("  - Do NOT fabricate clause numbers. If unsure, omit rather than invent.");
    parts.push("");
    parts.push("Retrieved clauses:");
    parts.push("");
    for (const c of retrievedClauses) {
      parts.push(`### ${c.citation} — ${c.title}`);
      if (c.parentTitle) parts.push(`(within: ${c.parentTitle})`);
      parts.push(c.text);
      parts.push("");
    }
  }

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
  /** Optional list of clauses retrieved from the local 3GPP corpus
   *  (added in v0.1.6). When present, they're injected into the user
   *  prompt as "## Reference spec excerpts" so the model can cite them
   *  by canonical form rather than guessing from training data. The
   *  triage API route at app/api/tickets/[id]/triage/route.ts calls
   *  retrieveContext() on the ticket and passes the result through. */
  retrievedClauses?: RetrievedClause[];
  /** Whether to look up the model's emitted specReferences against the
   *  corpus after the LLM returns. v0.1.7: defaults to `true` for
   *  backwards compatibility, but the triage route sets this to `false`
   *  when the user has flipped off the "Use 3GPP corpus" toggle so
   *  non-cellular tickets don't get incorrect corpus matches grafted
   *  onto whatever the model invented. */
  enrichWithCorpus?: boolean;
}

export async function runTriage(
  ticket: TicketDetail,
  opts: TriageOptions = {},
): Promise<TriageResult> {
  const s = loadSettings();
  const userPrompt = buildUserPrompt(ticket, opts.followup, opts.retrievedClauses);

  // Default to enriching unless the caller explicitly disabled it. The
  // triage routes pass `false` when the per-triage RAG toggle is off.
  const enrichWithCorpus = opts.enrichWithCorpus !== false;

  // Resolve the model FIRST — we need it both for the vision-capability
  // gate below and for the per-provider dispatch.
  // claude-cli accepts the same Anthropic shorthand names ("opus",
  // "sonnet", "haiku") OR full ids; default to "opus" for the kind of
  // multi-layer triage reasoning this prompt needs. If the user's
  // Settings has a non-Anthropic model id (e.g. left over from a
  // previous openai-compatible run), fall back to opus on the CLI path.
  let model = opts.model || s.defaultModel || DEFAULT_MODEL;
  if (s.llmProvider === "claude-cli" && !/^(opus|sonnet|haiku|claude-)/i.test(model)) {
    model = "opus";
  }
  // codex-cli accepts GPT / o-series model ids. If the user's stored
  // `defaultModel` is a Claude name (left over from a previous claude-cli
  // session) we leave `model` blank so codex picks up its own default
  // from ~/.codex/config.toml. Anything that LOOKS like a GPT/o-model
  // gets passed through — but lowercased, because the codex backend
  // matches model ids case-sensitively (server returns
  // `'GPT-5.5' model is not supported` for an uppercased id even when
  // the lowercase 'gpt-5.5' is allowed on the same subscription).
  if (s.llmProvider === "codex-cli") {
    if (!/^(gpt-|o\d|chatgpt-|codex)/i.test(model)) {
      model = "";   // → omit --model flag, codex uses its configured default
    } else {
      model = model.toLowerCase();
    }
  }

  // Vision: when the provider/model combo supports image content blocks,
  // fetch the ticket's image attachments now and pass them through to
  // the provider-specific dispatch. Skipped entirely for DeepSeek / any
  // model we don't recognise as vision-capable — saves the second
  // Bugzilla REST call and the bandwidth.
  const visionSupported = providerSupportsVision(s.llmProvider, model);
  const ticketImages = visionSupported ? await loadImageAttachments(ticket) : [];

  // Corpus-figure vision (v3 / Phase 2): when the retrieval surfaced
  // clauses with paired figure images and the provider is vision-capable,
  // attach the raster blobs (PNG/JPEG/GIF) as vision content blocks
  // too. SVG blobs are skipped — neither the Anthropic nor OpenAI
  // vision endpoints accept SVG natively, and rasterising server-side
  // is a heavier follow-up. The SpecDrawer still renders SVGs in the
  // UI (browser does it natively). Capped at MAX_CORPUS_FIGURE_IMAGES
  // total per triage to keep token cost bounded on a 4-clause
  // retrieved-context set.
  const corpusFigureImages = visionSupported && opts.retrievedClauses
    ? loadCorpusFigureImages(opts.retrievedClauses)
    : [];

  // Combine: ticket attachments first (most directly relevant —
  // they're FROM this ticket), then corpus figures (background spec
  // diagrams). Manifest-text injection in the user prompt names them
  // separately so the model knows which images came from which source.
  const images = [...ticketImages, ...corpusFigureImages];

  // PDFs: every provider gets PDFs in some form. Anthropic gets native
  // document blocks (best fidelity); everyone else (OpenAI-compatible
  // including DeepSeek, plus the claude-cli text-prompt path) gets
  // server-side extracted text appended to the user prompt. The Bugzilla
  // REST round-trip is gated on whether the ticket has any PDF at all
  // (cheap pre-filter on the metadata we already have), so tickets
  // without PDFs pay no cost.
  const pdfNative = providerSupportsNativePdf(s.llmProvider);
  const { nativePdfs, extractedTexts: pdfTexts } =
    await loadPdfAttachments(ticket, pdfNative);

  // claude-cli path skips the API-key gate — it uses the local `claude`
  // binary's stored Claude Code subscription auth. Selected automatically
  // when CLAUDECODE=1 and no API key, or explicitly via Settings. PDFs
  // are passed as extracted text in the prompt (the CLI's -p path takes
  // a single text positional, not document blocks).
  if (s.llmProvider === "claude-cli") {
    const promptWithPdfs = appendPdfTexts(userPrompt, pdfTexts);
    return runTriageClaudeCli({
      model,
      userPrompt: promptWithPdfs,
      ticketId: ticket.id,
      enrichWithCorpus,
    });
  }

  // codex-cli path — same auth model as claude-cli but routes through
  // OpenAI's `codex exec` binary. Uses the ChatGPT subscription on the
  // host machine (no API key). Images go through the CLI's `-i` flag
  // (saved to tmp files first); PDFs go as extracted text since the
  // CLI doesn't expose a `--pdf` flag.
  if (s.llmProvider === "codex-cli") {
    const promptWithPdfs = appendPdfTexts(userPrompt, pdfTexts);
    return runTriageCodexCli({
      model,
      userPrompt: promptWithPdfs,
      ticketId: ticket.id,
      enrichWithCorpus,
      images,
    });
  }

  const apiKey = opts.apiKey || s.anthropicApiKey;
  if (!apiKey) {
    throw new Error(
      "LLM API key not configured. Open the Settings page (gear icon in the header) " +
      "and enter the API key for your selected provider, then try the triage again. " +
      "Tip: if you have a Claude Code subscription, launch this app from inside a " +
      "`claude` session — it'll route triage through the CLI automatically (no key needed).",
    );
  }
  const baseURL = s.llmBaseUrl?.trim() || undefined;

  if (s.llmProvider === "openai-compatible") {
    // No native PDF support on the chat-completions surface — text
    // extraction is appended to the user prompt and PDFs themselves are
    // not sent as content blocks.
    return runTriageOpenAI({
      apiKey, baseURL, model,
      userPrompt: appendPdfTexts(userPrompt, pdfTexts),
      ticketId: ticket.id, enrichWithCorpus, images,
    });
  }
  // Anthropic path — native PDFs go as document blocks (carries figures
  // and layout), no need to pre-extract text. Empty `pdfTexts` here.
  return runTriageAnthropic({
    apiKey, baseURL, model, userPrompt,
    ticketId: ticket.id, enrichWithCorpus, images,
    nativePdfs,
  });
}

/** True when the configured provider can actually be called: CLI providers
 *  use a subscription (no key), SDK providers need a key (and a baseURL for
 *  openai-compatible). Used to gate the opt-in LLM reranker — never to gate
 *  plain hybrid search. */
export function hasConfiguredLlmProvider(s = loadSettings()): boolean {
  switch (s.llmProvider) {
    case "claude-cli":
    case "codex-cli":
      return true; // subscription via local binary
    case "openai-compatible":
      return !!s.anthropicApiKey && !!s.llmBaseUrl;
    case "anthropic":
    default:
      return !!s.anthropicApiKey;
  }
}

// ── Anthropic path ────────────────────────────────────────────────

interface ProviderCallArgs {
  apiKey: string;
  baseURL: string | undefined;
  model: string;
  userPrompt: string;
  ticketId: number;
  enrichWithCorpus: boolean;
  /** Image attachments to inline as vision content blocks. Empty array
   *  when the provider/model isn't vision-capable or the ticket has no
   *  image attachments — both branches collapse to the text-only path. */
  images: InlineImage[];
}

interface AnthropicCallArgs extends ProviderCallArgs {
  /** PDFs to pass as native `document` content blocks (Anthropic only). */
  nativePdfs: InlinePdf[];
}

async function runTriageAnthropic(args: AnthropicCallArgs): Promise<TriageResult> {
  const { apiKey, baseURL, model, userPrompt, ticketId, enrichWithCorpus, images, nativePdfs } = args;
  const client = new Anthropic({ apiKey, baseURL });

  // Build the user message. Text-only when there are no attachments —
  // keeps the cache-key shape stable for the common case. Otherwise
  // text first (so the model has structured ticket context), then
  // images, then PDFs. Order matters for cache reuse: stable across
  // re-triages of the same ticket.
  const hasAttachments = images.length > 0 || nativePdfs.length > 0;
  const userContent: Anthropic.MessageParam["content"] = !hasAttachments
    ? userPrompt
    : [
        { type: "text", text: appendAttachmentManifest(userPrompt, images, nativePdfs) },
        ...images.map(img => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: img.mediaType,
            data: img.base64,
          },
        })),
        ...nativePdfs.map(pdf => ({
          type: "document" as const,
          source: {
            type: "base64" as const,
            media_type: "application/pdf" as const,
            data: pdf.base64,
          },
          // Anthropic supports a per-document title that shows up in the
          // model's mental index — use the original filename so the model
          // can refer to it ("see Figure 3 in test-report.pdf").
          title: pdf.fileName,
        })),
      ];

  // output_config.format with json_schema makes Anthropic validate the
  // response against the schema server-side, so the first content block
  // is guaranteed to be valid JSON matching TRIAGE_SCHEMA.
  const response = await client.messages.create({
    model,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
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

  const result = {
    ...parsed,
    ticketId,
    generatedAt: new Date().toISOString(),
    model: response.model || model,
  } as TriageResult;
  // Enrich excerpts with corpus lookups BEFORE the CLASSIFICATION
  // header is rendered (so realText wins over summary in the header).
  // Skipped when the caller disabled RAG — non-cellular tickets
  // shouldn't have corpus citations grafted onto whatever the model
  // emitted.
  const enriched = enrichWithCorpus ? enrichExcerptsWithCorpus(result) : result;
  return withClassificationPrepended(enriched);
}

// ── OpenAI-compatible path ────────────────────────────────────────

// Per-call format strategy. OpenAI itself accepts the strict `json_schema`
// type, but most "OpenAI-compatible" providers don't:
//   - DeepSeek returns: 400 "This response_format type is unavailable now"
//   - Together / OpenRouter / Ollama / vLLM / Azure all reject json_schema
//   - Old gpt-3.5 era endpoints reject it
// They DO accept the older `json_object` type, which guarantees syntactic
// JSON but doesn't enforce a schema server-side. We compensate by appending
// the schema (as JSON) to the system prompt so the model knows the shape.
// That works on DeepSeek, OpenAI, Together, OpenRouter, Ollama, Azure, vLLM.
//
// `json_object` mode also REQUIRES the word "JSON" to appear in the
// system or user message — including the schema satisfies that.
const SCHEMA_INSTRUCTION = `
Respond with a single JSON object that conforms exactly to the schema below.
No prose, no markdown fences, no preamble — only the JSON object.

SCHEMA:
${JSON.stringify(TRIAGE_SCHEMA, null, 2)}
`.trim();

async function runTriageOpenAI(args: ProviderCallArgs): Promise<TriageResult> {
  const { apiKey, baseURL, model, userPrompt, ticketId, enrichWithCorpus, images } = args;
  // The openai SDK requires *some* baseURL even when pointing at api.openai.com.
  // We let it use its own default when the user left baseURL blank — that's
  // an unusual configuration (the user picked "OpenAI-compatible" but with
  // no URL), but the validateSettings step should have caught it earlier.
  const client = new OpenAI({ apiKey, baseURL });

  const systemContent = `${SYSTEM_PROMPT}\n\n${SCHEMA_INSTRUCTION}`;

  // Multimodal user content when images are present — OpenAI's content
  // array format with `image_url` blocks pointing at data URLs. Falls
  // through to a plain string for the common text-only case.
  type OpenAITextPart = { type: "text"; text: string };
  type OpenAIImagePart = { type: "image_url"; image_url: { url: string } };
  const userContent: string | Array<OpenAITextPart | OpenAIImagePart> =
    images.length === 0
      ? userPrompt
      : [
          // PDF text has already been appended to `userPrompt` upstream
          // (see the OpenAI dispatch in runTriage). Here we only need the
          // image-manifest header — pass an empty PDF array.
          { type: "text", text: appendAttachmentManifest(userPrompt, images, []) } satisfies OpenAITextPart,
          ...images.map(img => ({
            type: "image_url" as const,
            image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
          }) satisfies OpenAIImagePart),
        ];

  const response = await client.chat.completions.create({
    model,
    max_tokens: 8000,
    messages: [
      { role: "system", content: systemContent },
      // Cast: the openai SDK's content typing is strict over content-part
      // unions per model, but the runtime accepts our shape on every
      // vision-capable provider we've tested.
      { role: "user", content: userContent } as OpenAI.Chat.ChatCompletionUserMessageParam,
    ],
    // json_object mode is the broadly-supported subset — guarantees the
    // body parses as JSON, leaves shape enforcement to the schema-in-prompt
    // above. Drop to plain text if even this isn't supported (rare).
    response_format: { type: "json_object" },
  });

  const text = response.choices[0]?.message?.content;
  if (!text) {
    throw new Error("OpenAI-compatible API returned no message content");
  }

  // Defensive parse: some providers wrap JSON in a markdown code fence
  // despite the explicit instruction not to. Strip it before parsing.
  const cleaned = stripJsonFence(text);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `OpenAI-compatible response was not valid JSON: ${msg}. ` +
      `First 200 chars: ${cleaned.slice(0, 200)}`,
    );
  }

  // Fill in missing fields with safe defaults — without server-side schema
  // validation, the model may omit fields. Filling defaults here keeps the
  // UI from crashing while still surfacing the model's actual output where
  // it provided one.
  const filled = fillTriageDefaults(parsed, ticketId, response.model || model);
  // Enrich BEFORE prepending CLASSIFICATION — header rendering prefers
  // realText (corpus) over summary (model paraphrase). Skipped when
  // the user has flipped off the per-triage RAG toggle.
  const enriched = enrichWithCorpus ? enrichExcerptsWithCorpus(filled) : filled;
  return withClassificationPrepended(enriched);
}

// ── Claude Code CLI path ──────────────────────────────────────────
//
// Spawns the local `claude` binary in headless mode:
//
//   claude -p --output-format json --model <model>
//          --system-prompt <sys>
//          <user-prompt>
//
// Why this path exists: the desktop's Anthropic path uses an API key
// (per-token billing), but a Claude Code subscription includes generous
// model usage already paid for. When the user launches the dev server
// (or eventually the packaged app) from inside a `claude` session,
// CLAUDECODE=1 is set in the environment and we route through here
// instead — using the subscription credentials the CLI has stored.
//
// We intentionally do NOT pass `--bare`. It looks attractive for cold-
// start latency but it strips the OAuth/keychain auth path, leaving the
// CLI to require an explicit ANTHROPIC_API_KEY — defeating the whole
// point of routing through the subscription. Without `--bare` the CLI
// reads its stored auth on startup the same way an interactive session
// would (~3-5 s cold start; acceptable for triage).
//
// Output shape: `--output-format json` wraps the model's response in
//   { "result": "<text>", "session_id": ..., "duration_ms": ... }
// — `result` is what we want. The model is instructed (via the schema
// in the system prompt) to emit JSON only, so `result` itself parses
// as the TriageResult shape.

interface ClaudeCliCallArgs {
  model: string;
  userPrompt: string;
  ticketId: number;
  enrichWithCorpus: boolean;
}

async function runTriageClaudeCli(args: ClaudeCliCallArgs): Promise<TriageResult> {
  const { model, userPrompt, ticketId, enrichWithCorpus } = args;

  // Same SCHEMA_INSTRUCTION that the OpenAI-compatible path uses — appends
  // the JSON schema after the base system prompt so the model knows the
  // exact shape it must emit. claude-cli's --json-schema flag could be
  // used here too, but appending to the system prompt is more portable
  // across CLI versions and keeps the parsing path identical to the
  // OpenAI-compatible branch.
  const systemPrompt = `${SYSTEM_PROMPT}\n\n${SCHEMA_INSTRUCTION}`;

  // Note on `--bare`: tempting for cold-start latency, but it explicitly
  // disables OAuth/keychain reads ("Anthropic auth is strictly
  // ANTHROPIC_API_KEY or apiKeyHelper via --settings" per the CLI's own
  // help). The whole point of this provider is to use the Claude Code
  // SUBSCRIPTION (not an API key), so we must let the CLI read its
  // keychain entry. Live with the small startup overhead.
  const cliArgs = [
    "-p",                       // non-interactive print mode
    "--output-format", "json",  // wrap the result in metadata JSON
    "--model", model,           // opus / sonnet / haiku / full id
    "--system-prompt", systemPrompt,
    // The user prompt goes as a positional argument. The CLI handles
    // argv-length limits internally; if it ever becomes a problem we
    // can switch to stdin via --input-format=text.
    userPrompt,
  ];

  const stdout = await spawnAndCapture("claude", cliArgs);

  // Parse the outer envelope first.
  let envelope: { result?: string };
  try {
    envelope = JSON.parse(stdout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `claude CLI returned non-JSON output: ${msg}. First 200 chars: ${stdout.slice(0, 200)}`,
    );
  }
  const resultText = (envelope.result || "").trim();
  if (!resultText) {
    throw new Error("claude CLI returned an empty result field");
  }

  // The result itself should be a JSON object matching TRIAGE_SCHEMA.
  // Strip a markdown fence defensively (some models emit one despite the
  // instruction not to).
  const cleaned = stripJsonFence(resultText);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `claude CLI result was not valid JSON: ${msg}. First 200 chars: ${cleaned.slice(0, 200)}`,
    );
  }

  const filled = fillTriageDefaults(parsed, ticketId, model);
  const enriched = enrichWithCorpus ? enrichExcerptsWithCorpus(filled) : filled;
  return withClassificationPrepended(enriched);
}

/** Spawn a child process and capture stdout. Rejects on non-zero exit
 *  with the captured stderr — surfaces auth/binary-missing errors to
 *  the user instead of swallowing them. */
function spawnAndCapture(cmd: string, cliArgs: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cliArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      // Don't inherit CLAUDECODE=1 — we're a child of the parent claude
      // session, but the subprocess should look like a fresh non-CC
      // invocation to avoid any recursive setup work. The CLI's own auth
      // store is read independently of this env var.
      env: { ...process.env, CLAUDECODE: undefined },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", chunk => out.push(chunk));
    child.stderr.on("data", chunk => err.push(chunk));
    child.on("error", e => {
      // ENOENT here means the `claude` binary isn't on PATH — most
      // helpful error message we can produce.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(
          "The `claude` CLI was not found on PATH. Install Claude Code from " +
          "https://claude.com/claude-code and run `claude` once to sign in, " +
          "then retry the triage.",
        ));
      } else {
        reject(e);
      }
    });
    child.on("close", code => {
      if (code === 0) {
        resolve(Buffer.concat(out).toString("utf8"));
      } else {
        const stderr = Buffer.concat(err).toString("utf8").trim();
        reject(new Error(
          `claude CLI exited with code ${code}. Stderr: ${stderr || "(empty)"}`,
        ));
      }
    });
  });
}

/** Generic, provider-agnostic one-shot LLM call: system + user prompt → raw
 *  text. A LEAN sibling of the runTriage<Provider> functions (deliberately NOT
 *  a refactor of them — the shipped triage path must stay untouched). Used by
 *  the corpus LLM reranker. Throws on hard provider failure; the caller
 *  catches and degrades to hybrid. No images/PDFs/JSON-schema.
 *  `opts.timeoutMs` bounds the call so a slow provider can't freeze search. */
export async function runLlmText(
  system: string,
  user: string,
  opts: { model?: string; maxTokens?: number; timeoutMs?: number } = {},
): Promise<string> {
  const s = loadSettings();
  const maxTokens = opts.maxTokens ?? 1024;
  const timeoutMs = opts.timeoutMs ?? 12_000;

  let model = opts.model || s.defaultModel || DEFAULT_MODEL;
  if (s.llmProvider === "claude-cli" && !/^(opus|sonnet|haiku|claude-)/i.test(model)) {
    model = "opus";
  }
  if (s.llmProvider === "codex-cli") {
    model = /^(gpt-|o\d|chatgpt-|codex)/i.test(model) ? model.toLowerCase() : "";
  }

  const withTimeout = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, rej) =>
        setTimeout(() => rej(new Error(`runLlmText timed out after ${timeoutMs}ms`)), timeoutMs)),
    ]);

  if (s.llmProvider === "anthropic") {
    const client = new Anthropic({ apiKey: s.anthropicApiKey });
    const resp = await withTimeout(client.messages.create({
      model, max_tokens: maxTokens, system,
      messages: [{ role: "user", content: user }],
    }));
    const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    return (block?.text ?? "").trim();
  }

  if (s.llmProvider === "openai-compatible") {
    const client = new OpenAI({ apiKey: s.anthropicApiKey, baseURL: s.llmBaseUrl });
    const resp = await withTimeout(client.chat.completions.create({
      model, max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }));
    return (resp.choices[0]?.message?.content ?? "").trim();
  }

  if (s.llmProvider === "claude-cli") {
    const stdout = await withTimeout(spawnAndCapture("claude", [
      "-p", "--output-format", "json", "--model", model,
      "--system-prompt", system, user,
    ]));
    let envelope: { result?: string };
    try { envelope = JSON.parse(stdout); }
    catch { throw new Error(`claude CLI returned non-JSON: ${stdout.slice(0, 200)}`); }
    return (envelope.result ?? "").trim();
  }

  if (s.llmProvider === "codex-cli") {
    const combined = `${system}\n\n---\n\n${user}`;
    const tmpRoot = path.join(os.tmpdir(), `corpus-rerank-${randomBytes(6).toString("hex")}`);
    await fs.mkdir(tmpRoot, { recursive: true });
    try {
      const outputPath = path.join(tmpRoot, "result.txt");
      const cliArgs = ["exec", "--skip-git-repo-check", "--sandbox", "read-only",
        "--ephemeral", "--cd", tmpRoot, "-o", outputPath];
      if (model) cliArgs.push("-m", model);
      cliArgs.push("-");
      await withTimeout(spawnAndDrain("codex", cliArgs, combined));
      return (await fs.readFile(outputPath, "utf8")).trim();
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  }

  throw new Error(`runLlmText: unsupported provider ${s.llmProvider}`);
}

// ── OpenAI Codex CLI path ─────────────────────────────────────────
//
// Spawns the local `codex` binary in headless mode:
//
//   codex exec --skip-git-repo-check --sandbox read-only --ephemeral
//              [-m <model>] [-i <image-path>...]
//              -o <output-file>
//              "<prompt>"
//
// Why this path exists: parallel to the claude-cli provider, but for
// ChatGPT subscriptions. Users with a ChatGPT Plus/Pro/Team plan can
// route triage through their subscription instead of paying per-token
// for an OpenAI API key.
//
// Image input: codex exec accepts one or more `-i <FILE>` flags. We
// fetch each image attachment from Bugzilla, write it to a per-triage
// tmp directory, pass the paths through, and unlink the directory in
// the finally block. Files never persist across triage runs.
//
// PDF input: codex doesn't expose a one-shot PDF flag, so PDFs go
// through our server-side text-extraction path (the `pdfTexts` get
// appended to the user prompt by the runTriage dispatch — same as the
// claude-cli and openai-compatible branches).
//
// Output capture: `-o <file>` writes ONLY the final assistant message
// to the file (no JSON envelope, no event stream). That's what we want
// — the prompt's SCHEMA_INSTRUCTION coerces the model into emitting a
// single JSON object as that final message, which we parse downstream.
// Stdout itself is a noisy human-friendly event stream; we drain it but
// ignore the contents.
//
// Sandboxing: `--sandbox read-only --ephemeral --skip-git-repo-check`
// keeps the subprocess from touching the filesystem outside the tmp dir
// and from persisting any session state. The triage prompt is text +
// images; we don't want codex to spawn shell commands or write files.

interface CodexCliCallArgs {
  /** Model id like "gpt-5", "o3", "o4-mini". Empty string ("") means
   *  "use codex's configured default" — we omit the --model flag in
   *  that case so ~/.codex/config.toml wins. */
  model: string;
  userPrompt: string;
  ticketId: number;
  enrichWithCorpus: boolean;
  /** Images to attach. Each gets written to a tmp file and passed via
   *  `-i <path>`. Empty array → text-only invocation. */
  images: InlineImage[];
}

async function runTriageCodexCli(args: CodexCliCallArgs): Promise<TriageResult> {
  const { model, userPrompt, ticketId, enrichWithCorpus, images } = args;

  // Combine system + schema instruction + user prompt into a single
  // positional argument. codex has no `--system-prompt` flag (its own
  // baseline instructions are loaded from ~/.codex), so we prepend
  // ours to the user message. The model still sees the JSON schema
  // it must emit because SCHEMA_INSTRUCTION includes the schema body.
  const combinedPrompt = `${SYSTEM_PROMPT}\n\n${SCHEMA_INSTRUCTION}\n\n---\n\n${userPrompt}`;

  // Per-triage tmp dir. The random suffix prevents collisions between
  // concurrent triages of different tickets. Cleaned up in `finally`.
  const tmpRoot = path.join(
    os.tmpdir(),
    `bugzilla-triage-codex-${ticketId}-${randomBytes(6).toString("hex")}`,
  );
  await fs.mkdir(tmpRoot, { recursive: true });

  try {
    // 1. Save images to disk so codex can attach them.
    const imagePaths: string[] = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      // Pick the file extension from the media type so codex's mime
      // sniff works correctly. "image/jpeg" → "jpg" is the one
      // non-trivial mapping.
      const ext = img.mediaType === "image/jpeg" ? "jpg"
                : img.mediaType === "image/png"  ? "png"
                : img.mediaType === "image/gif"  ? "gif"
                : "webp";
      const imgPath = path.join(tmpRoot, `image-${i}.${ext}`);
      await fs.writeFile(imgPath, Buffer.from(img.base64, "base64"));
      imagePaths.push(imgPath);
    }
    const outputPath = path.join(tmpRoot, "result.json");

    // 2. Build the codex argv.
    //
    // IMPORTANT: `codex exec`'s `-i / --image <FILE>...` flag is
    // VARIADIC — clap greedily consumes every positional argument that
    // follows until the next flag. If we appended the prompt as a
    // positional after `-i img.png`, codex would parse the prompt as a
    // second image path, leave [PROMPT] empty, and fall back to reading
    // stdin → producing "No prompt provided via stdin". So we pass `-`
    // as the explicit "read prompt from stdin" sentinel and pipe the
    // prompt through child.stdin. This also dodges OS argv-length caps
    // (~256 KB on macOS, 128 KB on Linux) which a big triage prompt
    // plus PDF text could brush against.
    const cliArgs: string[] = [
      "exec",
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "--ephemeral",
      // Make the working dir something safe (the tmp dir) — codex
      // refuses to run outside a git repo by default; --skip handles
      // that, but --cd also keeps the agent's notion of "the project"
      // from leaking into the prompt context (it sometimes auto-reads
      // README/CLAUDE.md if launched from a repo).
      "--cd", tmpRoot,
      "-o", outputPath,
    ];
    if (model) cliArgs.push("-m", model);
    for (const p of imagePaths) cliArgs.push("-i", p);
    // `-` tells codex to read the prompt body from stdin. Must come
    // AFTER any --image flags so the variadic consumer stops at this
    // positional (clap treats `-` as a positional terminator).
    cliArgs.push("-");

    // 3. Spawn, feed the prompt via stdin, wait. Codex writes status
    // messages to stdout — we drain those, capture stderr for error
    // reporting, and read the answer from the `-o` file once the
    // process exits.
    await spawnAndDrain("codex", cliArgs, combinedPrompt);

    // 4. Read + parse the answer.
    let resultText: string;
    try {
      resultText = (await fs.readFile(outputPath, "utf8")).trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `codex CLI did not produce an output file (${outputPath}): ${msg}. ` +
        `The model may have refused to answer or run out of turns — check that you've run \`codex login\`.`,
      );
    }
    if (!resultText) {
      throw new Error("codex CLI produced an empty output file");
    }
    const cleaned = stripJsonFence(resultText);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `codex CLI result was not valid JSON: ${msg}. First 200 chars: ${cleaned.slice(0, 200)}`,
      );
    }
    const filled = fillTriageDefaults(parsed, ticketId, model || "codex-default");
    const enriched = enrichWithCorpus ? enrichExcerptsWithCorpus(filled) : filled;
    return withClassificationPrepended(enriched);
  } finally {
    // Clean up images + output file even if codex crashed. recursive
    // + force = no error if the dir is already gone.
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort — tmp will get GC'd by the OS eventually anyway
    }
  }
}

/** Spawn a child process, drain stdout (we don't need it for the
 *  codex path — the output we care about lives in the `-o` file),
 *  capture stderr, and resolve when it exits. Optionally pipes
 *  `stdinPayload` to the child's stdin (used by the codex path to
 *  feed the prompt body — see runTriageCodexCli for the variadic-
 *  flag rationale). Rejects with the captured stderr on non-zero
 *  exit. ENOENT is special-cased so a missing `codex` binary produces
 *  a useful install-instructions error rather than a generic spawn
 *  failure. */
function spawnAndDrain(
  cmd: string,
  cliArgs: string[],
  stdinPayload?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cliArgs, {
      stdio: [stdinPayload != null ? "pipe" : "ignore", "pipe", "pipe"],
      // Strip CLAUDECODE so codex doesn't think it's nested under a
      // Claude Code session. Codex itself has no equivalent recursive
      // env, so we don't need to strip anything else.
      env: { ...process.env, CLAUDECODE: undefined },
    });
    const err: Buffer[] = [];
    // Drain stdout — codex emits a human-friendly event stream there
    // that we don't need. If we leave it un-piped, the OS pipe buffer
    // can fill up and stall the child. TS narrows stdout/stderr to
    // `Readable | null` because the stdio tuple is conditional above;
    // at runtime both are always piped, so the `?.` is defensive only.
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", chunk => err.push(chunk));
    child.on("error", e => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(
          "The `codex` CLI was not found on PATH. Install OpenAI Codex CLI " +
          "(npm install -g @openai/codex) and run `codex login` once to sign " +
          "in with your ChatGPT subscription, then retry the triage.",
        ));
      } else {
        reject(e);
      }
    });
    child.on("close", code => {
      if (code === 0) {
        resolve();
      } else {
        const stderr = Buffer.concat(err).toString("utf8").trim();
        reject(new Error(
          `codex CLI exited with code ${code}. Stderr: ${stderr || "(empty)"}`,
        ));
      }
    });
    // Write the prompt body and close stdin so codex sees EOF and
    // stops waiting for more input. Wrapped in a try because the
    // child may have already died (ENOENT) before stdin is available.
    if (stdinPayload != null && child.stdin) {
      try {
        child.stdin.end(stdinPayload);
      } catch {
        // already errored — the `error` handler above will reject
      }
    }
  });
}

/** Append a short note to the text prompt listing the inline image and
 *  PDF content blocks that follow. Without this hint the model sometimes
 *  describes attachments generically ("a screenshot was attached") rather
 *  than pulling specific evidence out of them. */
function appendAttachmentManifest(
  userPrompt: string,
  images: InlineImage[],
  pdfs: InlinePdf[],
): string {
  if (images.length === 0 && pdfs.length === 0) return userPrompt;
  const lines: string[] = [userPrompt, ""];
  if (images.length > 0) {
    lines.push("## Inline image attachments");
    lines.push("");
    lines.push("The following image attachments are included as vision content blocks below the text — analyse them as primary evidence (e.g. spectrum-analyser screenshots, EVM plots, AT-command screenshots, schematics, error dialogs). Quote specific values you can read off the images in the OBSERVED section.");
    lines.push("");
    images.forEach((img, i) => {
      lines.push(`  ${i + 1}. ${img.fileName} (${img.mediaType})`);
    });
    lines.push("");
  }
  if (pdfs.length > 0) {
    lines.push("## Inline PDF attachments");
    lines.push("");
    lines.push("The following PDF documents are included as document content blocks below. Read them as primary evidence — quote specific clause numbers, test-report values, log timestamps, or table entries when citing in the OBSERVED section. PDFs are often the source of truth for 3GPP change requests, conformance test reports, and customer compliance evidence.");
    lines.push("");
    pdfs.forEach((p, i) => {
      lines.push(`  ${i + 1}. ${p.fileName}`);
    });
    lines.push("");
  }
  return lines.join("\n");
}

/** Same role as `appendAttachmentManifest`, but for the providers that
 *  don't accept native PDF document blocks (OpenAI-compatible, claude-cli).
 *  The extracted page text is inlined into the user prompt so DeepSeek
 *  / GPT / Llama can still reason over PDF contents — just without
 *  figures or visual layout. */
function appendPdfTexts(userPrompt: string, texts: ExtractedPdfText[]): string {
  if (texts.length === 0) return userPrompt;
  const lines: string[] = [userPrompt, ""];
  lines.push("## PDF attachments (text extracted server-side)");
  lines.push("");
  lines.push("The following PDF documents were attached to the ticket. Their page text has been extracted and is included verbatim below — quote specific values, clause numbers, test-report rows, or log lines when citing in the OBSERVED section. Figures and visual layout are NOT included (text-only extraction); if a figure looks important, recommend the reporter share a screenshot.");
  lines.push("");
  for (const t of texts) {
    const truncNote = t.truncatedAt
      ? ` (TRUNCATED at page ${t.truncatedAt} of ${t.numPages} — likely too long for a full inline read)`
      : ` (${t.numPages} page${t.numPages === 1 ? "" : "s"})`;
    lines.push(`### PDF: ${t.fileName}${truncNote}`);
    lines.push("");
    // Wrap the extracted text in a clear delimiter so the model knows
    // where this PDF starts and ends — particularly important when
    // multiple PDFs are inlined.
    lines.push("```");
    lines.push(t.text || "[no extractable text — likely a scanned-image PDF]");
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

/** Strip a leading ```json … ``` fence if the model included one despite
 *  being told not to. Idempotent on already-clean JSON. */
function stripJsonFence(s: string): string {
  const trimmed = s.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (fenced ? fenced[1] : trimmed).trim();
}

/** Coerce a model response into a TriageResult, filling missing fields
 *  with safe empties. Only used by the OpenAI-compatible path where the
 *  server can't enforce the schema. */
function fillTriageDefaults(
  parsed: Record<string, unknown>,
  ticketId: number,
  model: string,
): TriageResult {
  const asArr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const asStr = (v: unknown, dflt = ""): string => (typeof v === "string" ? v : dflt);
  const conf = parsed.confidence;
  return {
    ticketId,
    generatedAt: new Date().toISOString(),
    model,
    confidence:
      conf === "high" || conf === "medium" || conf === "low" ? conf : "medium",
    domain: asStr(parsed.domain),
    specReferences: asArr<string>(parsed.specReferences),
    issueSummary: asStr(parsed.issueSummary),
    rootCauses: asArr<TriageResult["rootCauses"][number]>(parsed.rootCauses),
    missingInformation: asArr<string>(parsed.missingInformation),
    nextSteps: asArr<TriageResult["nextSteps"][number]>(parsed.nextSteps),
    escalationRecommendation: asStr(parsed.escalationRecommendation),
    internalSummary: asStr(parsed.internalSummary),
    customerSummary: asStr(parsed.customerSummary),
    bugzillaComment: asStr(parsed.bugzillaComment),
    specExcerpts: asArr<SpecExcerpt>(parsed.specExcerpts).filter(
      // Drop malformed entries — providers that aren't strict-schema can
      // emit nulls or partials. We keep only well-formed { clause, summary }
      // objects so the UI doesn't have to defend against missing keys.
      e => e && typeof e.clause === "string" && typeof e.summary === "string",
    ),
  };
}

// ──────────────────────────────────────────────────────────────────
// Classification header
//
// Built server-side from the structured fields (confidence / domain /
// specReferences / specExcerpts) and prepended to bugzillaComment so the
// final Bugzilla comment opens with a reference-rich summary section:
//
//   CLASSIFICATION
//   ==============
//   Confidence:  HIGH
//   Domain:      NR RF · AT-command surface · band n40 (TDD)
//   Issue:       Frequency offset valid only on first TX activation.
//
//   Spec references:
//     · 3GPP TS 38.211 §6.1.4
//       Defines the NR uplink reference signal generation including
//       frequency-offset application per resource grid slot.
//     · 3GPP TS 36.521 §6.5.1
//       LTE conformance test for transmitter frequency error.
//
//   ──────────────────────────────────────────────────────────────
//
//   OBSERVED:
//   …
//
// Reason this lives server-side rather than at the prompt level: lets us
// guarantee the format across providers (DeepSeek, Ollama, Together,
// OpenAI, etc. all behave differently w.r.t. system-prompt adherence),
// and lets us re-render cleanly if any of the parsed fields are edited
// in the UI — though for now we just bake it once at AI-response time.
// ──────────────────────────────────────────────────────────────────

const CLASSIFICATION_SENTINEL = "CLASSIFICATION";

function withClassificationPrepended(t: TriageResult): TriageResult {
  // If the model defied the prompt and produced its own CLASSIFICATION
  // header anyway, leave the body alone — avoids a duplicate header.
  if (t.bugzillaComment.trim().startsWith(CLASSIFICATION_SENTINEL)) return t;

  const header = renderClassificationHeader(t).trim();
  if (!header) return t;

  return {
    ...t,
    bugzillaComment: `${header}\n\n${t.bugzillaComment.trim()}`,
  };
}

function renderClassificationHeader(t: TriageResult): string {
  const lines: string[] = [];
  lines.push(CLASSIFICATION_SENTINEL);
  lines.push("==============");
  lines.push(`Confidence:  ${t.confidence.toUpperCase()}`);
  if (t.domain.trim()) lines.push(`Domain:      ${t.domain.trim()}`);
  if (t.issueSummary.trim()) lines.push(`Issue:       ${t.issueSummary.trim()}`);

  if (t.specReferences.length > 0) {
    lines.push("");
    lines.push("Spec references:");
    // Map clause → excerpt object so we can prefer realText (from the
    // local 3GPP corpus, populated by enrichExcerptsWithCorpus) over
    // summary (model paraphrase). Missing excerpts are fine, we just
    // print the clause alone in that case.
    const byClause = new Map<string, SpecExcerpt>();
    for (const e of t.specExcerpts) {
      if (e?.clause) byClause.set(e.clause.trim(), e);
    }
    for (const ref of t.specReferences) {
      const clause = ref.trim();
      if (!clause) continue;
      lines.push(`  · ${clause}`);
      const excerpt = byClause.get(clause);
      if (!excerpt) continue;
      // Prefer the corpus's authoritative text when available — render
      // the first ~280 chars as the header summary (the side-drawer at
      // M3 will show the full text on demand). The leading "[corpus]"
      // tag is a small honesty cue distinguishing real spec text from
      // the model's paraphrase.
      const bodyText = pickHeaderBody(excerpt);
      if (!bodyText) continue;
      for (const ln of bodyText.split(/\r?\n/)) {
        lines.push(`    ${ln}`);
      }
    }
  }

  lines.push("");
  lines.push("──────────────────────────────────────────────────────────────");
  return lines.join("\n");
}

/** Pick the best short text to render under a clause in the CLASSIFICATION
 *  header of the BUGZILLA COMMENT (the version posted to the bug, not
 *  the on-screen card).
 *
 *  Rules — tightened so the comment stays focused on triage signal
 *  rather than dumping the corpus:
 *    1. Use ONLY `summary` (1-2 sentence paraphrase). The full corpus
 *       text (`realText`) stays available in the UI's spec-reference
 *       card via the "View clause" button — it doesn't belong inside
 *       the Bugzilla comment where it bloats the analysis and shifts
 *       the reader's focus away from the model's own findings.
 *    2. NO `[corpus]` / `[ai paraphrase]` source-tag prefix. The tag
 *       is still rendered in the on-screen UI card for transparency,
 *       but in the Bugzilla comment it adds noise. The reader doesn't
 *       care whether the summary came from the corpus or the model —
 *       they want the spec-level reasoning, not the provenance.
 *    3. Hard-condense to ~160 chars so the per-clause line is a single
 *       readable sentence, not a paragraph.
 *    4. Return null (caller prints just the bare clause line) when
 *       there's no summary — better to omit than to dump corpus dump. */
function pickHeaderBody(e: SpecExcerpt): string | null {
  const summary = (e.summary || "").trim();
  if (!summary) return null;
  return condenseForHeader(summary, 160);
}

/** Trim a long clause body to a header-friendly snippet. Tries to cut at
 *  the end of a sentence within `maxLen` chars; otherwise hard-cuts with
 *  an ellipsis. Default 280 chars used by enrichExcerptsWithCorpus when
 *  auto-deriving a summary from corpus realText; the Bugzilla header
 *  passes a tighter 160 to keep each spec line on one line. */
function condenseForHeader(text: string, maxLen = 280): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLen) return flat;
  // Look for a sentence-end within the first maxLen chars.
  const window = flat.slice(0, maxLen);
  const lastSentence = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("? "),
    window.lastIndexOf("! "),
  );
  if (lastSentence > Math.floor(maxLen * 0.42)) return window.slice(0, lastSentence + 1);
  return window + "…";
}

/** Walk specReferences and, for each, try a corpus lookup. When a hit
 *  is found, attach `clauseId` / `title` / `parentTitle` / `realText` to
 *  the matching specExcerpts entry (creating one if the model didn't
 *  produce a paraphrase for that clause). Sets `source` so downstream
 *  UI can color/tag the excerpt accordingly.
 *
 *  No-op when the corpus isn't installed (lookupClause returns null for
 *  every reference). Pure function — returns a new TriageResult. */
function enrichExcerptsWithCorpus(t: TriageResult): TriageResult {
  if (!t.specReferences || t.specReferences.length === 0) return t;

  // Index the model's existing excerpts by clause for fast merge.
  const byClause = new Map<string, SpecExcerpt>();
  for (const e of t.specExcerpts ?? []) {
    if (e?.clause) byClause.set(e.clause.trim(), e);
  }

  for (const ref of t.specReferences) {
    const clause = ref.trim();
    if (!clause) continue;
    const hit = lookupClause(clause);
    if (!hit) {
      // No corpus match — tag whatever the model produced so the UI can
      // distinguish "model-only" from "corpus-backed" excerpts later.
      // Distinguish the reason: was the spec never curated (most common
      // when DeepSeek cites 38.304 / 38.133 / etc.), or is the spec in
      // the corpus but the specific clause doesn't resolve via the
      // ancestor-prefix fallback either? The UI tooltip / chip differs.
      const reason = lookupReasonFor(clause);
      const existing = byClause.get(clause);
      if (existing) {
        byClause.set(clause, {
          ...existing,
          source: existing.source ?? "model",
          lookupReason: reason,
        });
      } else {
        // The model emitted a reference but no excerpt — synthesise a
        // bare placeholder so the UI can render the citation + reason
        // chip even without paraphrase text.
        byClause.set(clause, { clause, summary: "", source: "model", lookupReason: reason });
      }
      continue;
    }
    const existing = byClause.get(clause);
    // Auto-condense the full corpus text into a short `summary` when the
    // model didn't supply one. The UI binds the editable textarea in the
    // Initial Classification bubble to `summary` — so this guarantees the
    // user always sees a short, editable preview, and the full clause
    // text stays accessible via the SpecDrawer's "View clause" button.
    const summary = (existing?.summary || "").trim() || condenseForHeader(hit.text);
    const merged: SpecExcerpt = {
      clause,
      summary,
      clauseId: hit.clauseId,
      title: hit.title,
      parentTitle: hit.parentTitle,
      realText: hit.text,
      source: existing?.summary ? "corpus+model" : "corpus",
    };
    byClause.set(clause, merged);
  }

  return { ...t, specExcerpts: Array.from(byClause.values()) };
}
