// lib/corpus/reranker-llm.ts — listwise LLM reranker (next-gen RAG).
// Reranks retrieval candidates by asking the user's CONFIGURED AI Triage
// provider to order the clauses by relevance. No bundled model. LLM-optional:
// only constructed when a provider is configured; ANY failure returns the
// input order / empty result so the retriever silently keeps its own order.
//
// PROVIDER-AGNOSTIC BY DESIGN. The desktop tests against one model but a
// deployed server routes this through whatever the deployment configured —
// company DeepSeek, a user's Anthropic key, an OpenAI-compatible proxy, or
// a local CLI. So the contract leans on nothing model-specific:
//   - no function calling / tool use / JSON mode — plain text completion
//   - the SYSTEM prompt pins the task and demands a bare JSON array output
//   - temperature 0 (deterministic; forwarded to API providers)
//   - "best first" ordering so a truncated output still ranks the head
//   - parsing tolerates markdown fences, surrounding prose, partial lists,
//     duplicates, out-of-range indices — and models that echo candidate ids
//     instead of indices. Anything unparseable degrades to the input order.
import "server-only";
import type { CorpusReranker } from "./reranker";
import { runLlmText, hasConfiguredLlmProvider } from "@/lib/llm";
import { getEffectiveSettings } from "@/lib/settings";

// ── Shared system prompt ──────────────────────────────────────────
// Kept deliberately terse and universal: every hosted/API/CLI model we
// route to must follow it without provider-specific coaxing (the deployed
// server may run a completely different model than the one tested).
//
// The ranking guidance encodes the same domain priors the fused ranking
// applies numerically (test-material down-weight, capability+procedure
// duality) — the LLM's order REPLACES the fused order, so without these
// the rerank silently undoes the tuned priors. Notably: engineers'
// "can X and Y happen together / how many X" questions are answered by
// UE-capability clauses (38.306/36.306 parameter definitions), which a
// naive "rank definitions of behaviour first" instruction buries under
// procedure text.
const SYSTEM =
  "You are a precise information-retrieval relevance ranker for 3GPP telecom specifications " +
  "(RAN1/RAN2/RAN4 physical layer, MAC/RRC procedures, UE capabilities, RF/conformance). " +
  "Order candidate spec clauses by how directly they answer the query, using these rules: " +
  "1) Clauses that directly answer rank first. Queries about whether/how signals or channels " +
  "can be transmitted together, overlap, coexist, or how many of something is supported have " +
  "TWO kinds of top answer: the procedure clause that defines the behaviour (e.g. 38.213/38.214/" +
  "38.321 procedures, including UCI multiplexing / collision handling for overlapping channels) " +
  "AND the UE-capability clause that states whether/how many/in which combinations the UE " +
  "supports it (e.g. 38.306/36.306 capability parameters like simultaneousTxSUL-NonSUL or " +
  "maxNumber… fields). Rank BOTH kinds at the top when present — capability parameter lists " +
  "are direct answers, not background. When the query counts instances (\"two X\", \"1 X + 1 Y\", " +
  "dual, multiple, simultaneous), the capability clause stating the supported number/combination " +
  "is a PRIMARY answer. " +
  "2) Conformance-TEST clauses (specs 38.523/38.521/38.508/36.523/36.521/36.508 and Annex test " +
  "cases) verify behaviour rather than define it — rank them below the normative clauses. " +
  "3) Definitional/abbreviation clauses and clauses that merely share vocabulary without " +
  "addressing the queried interaction rank last. " +
  "CRITICAL OUTPUT RULE: reply with EXACTLY ONE JSON array of integers and nothing else — " +
  "no prose, no explanation, no markdown code fences.";

/** Build the listwise prompt. Passages are pre-formatted (title-prefixed). */
function buildPrompt(query: string, passages: string[]): string {
  const list = passages.map((p, i) => `[${i}] ${p}`).join("\n\n");
  return `Query:\n${query}\n\nCandidate clauses:\n${list}\n\n` +
    `Rank ALL ${passages.length} candidates from most to least relevant to the query. ` +
    `Output ONLY a JSON array of the candidate indices (0-based) in ranked order, ` +
    `best first, every index exactly once. Example: [3,0,7,1].`;
}

/** Parse the model's index array defensively: keep valid in-range unique
 *  indices in stated order, then append any missing indices in original order
 *  so the result is always a full permutation.
 *
 *  Robust across providers: scans EVERY bracketed group in the reply (models
 *  wrap in ```json fences or lead with prose despite instructions) and keeps
 *  the group that yields the most valid indices. When `idLookup` is given,
 *  string entries that echo a candidate id (e.g. "38.213#9.2.5") map back to
 *  their index — some models do this no matter what the prompt says. */
export function parseOrder(raw: string, n: number, idLookup?: Map<string, number>): number[] {
  const groups = raw.match(/\[[^\]]*\]/g) ?? [];
  let best: number[] = [];
  for (const g of groups) {
    const order: number[] = [];
    const seen = new Set<number>();
    let parsed: unknown[] | null = null;
    try { parsed = JSON.parse(g) as unknown[]; } catch { /* try a lenient split */ }
    if (!parsed) {
      // Lenient fallback: strip brackets/quotes, split on commas.
      parsed = g.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
    }
    for (const v of parsed) {
      let i = Number(v);
      if (!Number.isInteger(i) && typeof v === "string" && idLookup) {
        const mapped = idLookup.get(v.trim());
        if (mapped !== undefined) i = mapped;
      }
      if (Number.isInteger(i) && i >= 0 && i < n && !seen.has(i)) { order.push(i); seen.add(i); }
    }
    if (order.length > best.length) best = order;
  }
  const seen = new Set(best);
  for (let i = 0; i < n; i++) if (!seen.has(i)) best.push(i);
  return best;
}

// ── Legacy pairwise-shaped hook (v5/v6 hybrid path) ───────────────
export class LlmReranker implements CorpusReranker {
  readonly modelId: string;
  constructor() {
    const s = getEffectiveSettings();
    this.modelId = `llm:${s.llmProvider}:${s.defaultModel || "default"}`;
  }
  async rerank(query: string, passages: string[]): Promise<number[]> {
    const n = passages.length;
    if (n === 0) return [];
    const identity = passages.map((_, i) => n - i); // input order preserved
    if (!hasConfiguredLlmProvider()) return identity;
    try {
      const raw = await runLlmText(SYSTEM, buildPrompt(query, passages), {
        maxTokens: 512, timeoutMs: 12_000, temperature: 0,
      });
      const order = parseOrder(raw, n);              // permutation, best-first
      // Map ranked position → descending score so the caller's sort reproduces
      // `order` (position 0 → highest score n).
      const scores = new Array<number>(n);
      order.forEach((idx, pos) => { scores[idx] = n - pos; });
      return scores;
    } catch {
      return identity; // never throw — degrade to hybrid order
    }
  }
}

/** Lazily build a singleton. */
let _llmReranker: LlmReranker | null = null;
export function getLlmReranker(): LlmReranker {
  return (_llmReranker ??= new LlmReranker());
}

// ── v2 union-pool listwise rerank (rel17-v7 retriever) ────────────
//
// The retriever-v2 handoff (corpus repo docs/desktop-port-retriever-v2.md §4):
// feed the LLM the UNION of the three candidate lists (~100–150 clauses,
// each as its best-matching ~300-token chunk), ONE listwise call at
// temperature 0, ids-only structured output, fused order as the fallback
// on failure/offline. The caller re-applies citation-pull afterwards.

export interface RerankCandidate {
  /** Canonical clause id, e.g. "38.213#9.2.5". */
  id: string;
  /** Pre-trimmed snippet: citation/title head + best-matching chunk. */
  text: string;
}

/** Hard cap on the pool a single listwise call sees. 3 lists × 50 = 150
 *  max by construction; the cap only guards future config drift. ~150
 *  candidates × ~300 tokens ≈ 45k prompt tokens — inside every provider
 *  we route to (DeepSeek 64k, Claude/GPT ≥128k). */
const MAX_POOL = 150;
// An index array of 150 entries is ~600 output tokens; 2048 leaves margin
// for models that space/pretty-print. Output is best-first, so even a
// truncated reply ranks the head correctly (parseOrder appends the rest).
const MAX_OUT_TOKENS = 2048;
// One big listwise call is slower than the 30-candidate legacy call —
// especially on the CLI providers (claude/codex spawn a subprocess and
// routinely take 60-100s on a ~45k-token prompt). Generous but bounded;
// API providers (DeepSeek/Anthropic/OpenAI-compatible) finish well under.
const TIMEOUT_MS = 120_000;

/** Rank the union candidate pool. Returns the ids best-first (a permutation
 *  of the input ids), or [] on ANY failure — the caller must treat [] as
 *  "keep the fused order". Never throws. */
export async function rerankUnionPool(
  query: string,
  candidates: RerankCandidate[],
): Promise<string[]> {
  if (candidates.length === 0) return [];
  if (!hasConfiguredLlmProvider()) return [];
  const pool = candidates.slice(0, MAX_POOL);
  try {
    const raw = await runLlmText(SYSTEM, buildPrompt(query, pool.map(c => c.text)), {
      maxTokens: MAX_OUT_TOKENS, timeoutMs: TIMEOUT_MS, temperature: 0,
    });
    const idLookup = new Map(pool.map((c, i) => [c.id, i]));
    const order = parseOrder(raw, pool.length, idLookup);
    return order.map(i => pool[i].id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[corpus] union-pool LLM rerank failed; keeping fused order:", err);
    return [];
  }
}
