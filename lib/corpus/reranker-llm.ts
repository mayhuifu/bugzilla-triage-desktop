// lib/corpus/reranker-llm.ts — listwise LLM reranker (next-gen RAG).
// Reranks the hybrid candidate pool by asking the user's CONFIGURED AI Triage
// provider to order the clauses by relevance. No bundled model. LLM-optional:
// only constructed when a provider is configured; ANY failure returns the
// input order (identity scores) so the retriever silently keeps hybrid.
import "server-only";
import type { CorpusReranker } from "./reranker";
import { runLlmText, hasConfiguredLlmProvider } from "@/lib/llm";
import { getEffectiveSettings } from "@/lib/settings";

const SYSTEM = "You are a precise information-retrieval relevance ranker for 3GPP " +
  "telecom specifications. You only output JSON.";

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
 *  so the result is always a full permutation. */
function parseOrder(raw: string, n: number): number[] {
  const m = raw.match(/\[[\s\d,]*\]/);
  const order: number[] = [];
  const seen = new Set<number>();
  if (m) {
    try {
      for (const v of JSON.parse(m[0]) as unknown[]) {
        const i = Number(v);
        if (Number.isInteger(i) && i >= 0 && i < n && !seen.has(i)) { order.push(i); seen.add(i); }
      }
    } catch { /* fall through to identity */ }
  }
  for (let i = 0; i < n; i++) if (!seen.has(i)) order.push(i);
  return order;
}

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
        maxTokens: 512, timeoutMs: 12_000,
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
