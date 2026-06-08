// ─────────────────────────────────────────────────────────────────
// lib/corpus/reranker-ce.ts — the bundled cross-encoder reranker that
// fixes the hybrid retriever's weak top-1 (next-gen RAG Phase A / v0.5.5).
//
// Implementation mirrors embedder-bge.ts: @huggingface/transformers
// (Transformers.js v4) running a small ONNX sequence-classification model.
// A cross-encoder reranker IS a sequence-classification model with a single
// relevance logit — there is no turnkey "rerank" pipeline in Transformers.js,
// so we load AutoTokenizer + AutoModelForSequenceClassification directly,
// tokenise each (query, passage) PAIR via `text_pair`, run the model, and
// read logits[:,0] as the relevance score (verified in scripts/spike-reranker.mjs).
//
// Loading strategy is identical to the embedder (the packaging-risk surface):
//   - PACKAGED build: model files bundled under <cwd>/models/<MODEL_REPO>/
//     via electron-builder extraResources; env.localModelPath points there,
//     env.allowRemoteModels=false → never hits the network.
//   - DEV (`npm run dev`): if the bundled dir is absent, allow remote
//     download from the HF hub (Transformers.js caches it locally).
//
// Everything is best-effort: any failure leaves the reranker unregistered
// (or makes rerank() throw, which the retriever catches and degrades to the
// plain hybrid order). Reranking is an enhancement, never a hard dependency.
// ─────────────────────────────────────────────────────────────────

import "server-only";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CorpusReranker } from "./reranker";
import { setCorpusReranker } from "./reranker";

// ── Model identity ────────────────────────────────────────────────
//
// The default is the tiny, proven MS-MARCO MiniLM cross-encoder (~23 MB q8).
// Overridable via RERANK_MODEL so the corpus eval (dev-rerank-eval.ts) can
// A/B a stronger model (e.g. Xenova/bge-reranker-base, ~110 MB) and we pick
// by measured MRR@10 / R@1 lift. The on-disk model dir under models/ must
// match whichever MODEL_REPO is staged by scripts/fetch-reranker-model.mjs.
const MODEL_REPO = process.env.RERANK_MODEL || "Xenova/ms-marco-MiniLM-L-6-v2";
// Quantisation of the bundled ONNX. q8 keeps it small; the embedder uses the
// same knob. Overridable for the eval A/B.
const DTYPE = (process.env.RERANK_DTYPE || "q8") as "q8" | "fp16" | "fp32";
// Per-forward-pass batch size. Candidate K is ~30, so the default fits in one
// batch; bounded to keep memory predictable if a caller reranks a wider set.
const BATCH = Math.max(1, Number(process.env.RERANK_BATCH) || 32);

/** Resolve the bundled-model directory if staged (see embedder-bge.ts for
 *  the full rationale). Returns null when unstaged so the caller allows a
 *  remote download (dev only). */
function bundledModelRoot(): string | null {
  const root = path.join(process.cwd(), "models");
  const cfg = path.join(root, ...MODEL_REPO.split("/"), "config.json");
  try {
    if (fs.existsSync(cfg)) return root;
  } catch { /* fall through to remote */ }
  return null;
}

// Loose types — @huggingface/transformers is ESM-only, dynamically imported.
type Tokenizer = (
  text: string[],
  opts: { text_pair: string[]; padding: boolean; truncation: boolean },
) => Promise<unknown>;
interface SeqClassOutput { logits: { tolist(): number[][] } }
type SeqClassModel = (inputs: unknown) => Promise<SeqClassOutput>;

class CrossEncoderReranker implements CorpusReranker {
  readonly modelId = MODEL_REPO;
  private _loaded: Promise<{ tokenizer: Tokenizer; model: SeqClassModel }> | null = null;

  /** Lazily load tokenizer + model exactly once. The heavy ONNX init
   *  happens on the FIRST rerank() call, guarded by a single in-flight
   *  promise so concurrent first calls don't load the model twice. */
  private load(): Promise<{ tokenizer: Tokenizer; model: SeqClassModel }> {
    if (this._loaded) return this._loaded;
    this._loaded = (async () => {
      const tf = (await import("@huggingface/transformers")) as unknown as {
        AutoTokenizer: { from_pretrained: (m: string, o?: Record<string, unknown>) => Promise<Tokenizer> };
        AutoModelForSequenceClassification: { from_pretrained: (m: string, o?: Record<string, unknown>) => Promise<SeqClassModel> };
        env: {
          allowRemoteModels: boolean;
          localModelPath: string;
          cacheDir: string;
          backends: { onnx: Record<string, unknown> };
        };
      };
      const root = bundledModelRoot();
      if (root) {
        tf.env.localModelPath = root;
        tf.env.cacheDir = root;
        tf.env.allowRemoteModels = false;
        // eslint-disable-next-line no-console
        console.info(`[corpus] reranker: loading ${MODEL_REPO} (${DTYPE}) from bundled ${root}`);
      } else {
        // eslint-disable-next-line no-console
        console.info(`[corpus] reranker: no bundled model dir; allowing remote download of ${MODEL_REPO} (${DTYPE})`);
      }
      const tokenizer = await tf.AutoTokenizer.from_pretrained(MODEL_REPO);
      const model = await tf.AutoModelForSequenceClassification.from_pretrained(MODEL_REPO, { dtype: DTYPE });
      return { tokenizer, model };
    })();
    // Clear the cached promise on failure so a later call can retry.
    this._loaded.catch(() => { this._loaded = null; });
    return this._loaded;
  }

  async rerank(query: string, passages: string[]): Promise<number[]> {
    if (passages.length === 0) return [];
    const { tokenizer, model } = await this.load();
    const scores: number[] = [];
    for (let i = 0; i < passages.length; i += BATCH) {
      const batch = passages.slice(i, i + BATCH);
      const inputs = await tokenizer(
        new Array(batch.length).fill(query),
        { text_pair: batch, padding: true, truncation: true },
      );
      const out = await model(inputs);
      // num_labels === 1 → logits shape [N, 1]; the single logit is the
      // relevance score. (If a model exposed 2 labels we'd take the
      // positive class, but the chosen rerankers are single-logit.)
      for (const row of out.logits.tolist()) scores.push(row[0]);
    }
    return scores;
  }
}

let _registered = false;

/** Register the bundled cross-encoder reranker so the retriever's
 *  hybrid-rrf+rerank path activates. Idempotent, synchronous, best-effort —
 *  a failure NEVER throws into the retrieval hot path (the app keeps working
 *  with the plain hybrid order). Constructing the reranker does NOT load the
 *  ONNX model; that's deferred to the first rerank() call.
 *
 *  Called lazily from the retriever (node-only) rather than instrumentation.ts
 *  (also edge-compiled) for the same reason as the embedder — see embedder-bge.ts. */
export function ensureRerankerRegistered(): void {
  if (_registered) return;
  // DEFAULT-OFF (eval-gated). v0.5.5: BOTH candidate cross-encoders regressed
  // top-1 in REPLACE mode on the 48-query set, so the shipped win was test-spec
  // demotion (+8pp R@1) and the reranker stayed dormant.
  // UPDATE 2026-06: re-eval on the 73-query hard set (10 added relational
  // multi-hop queries) found a real win — **bge-reranker-base in FUSE mode**:
  // +2.9 MRR@10 / +5.5 R@1 overall, +7.7 R@1 on BOTH relational and ranked-low,
  // cost = 1 top-1 demotion + R@10 −2.7. (ms-marco-MiniLM still loses; REPLACE
  // mode still tanks top-1.) HELD, not shipped: bge-reranker-base is 266 MB int8
  // (>5× the corpus) and this impl does REPLACE only — enabling needs (a) fuse
  // mode here + in retriever.ts and (b) a delivery story for the 266 MB model
  // (runtime download, not installer bundle). See EVAL-v0.5.5-reranker-findings.md
  // "Update 2026-06". Reproduce: RERANK_MODEL=Xenova/bge-reranker-base
  // RERANK_MODE=fuse GROUP_BY=mode EXCLUDE_TEST_SPECS=1 node scripts/dev-rerank-eval.mjs
  // The reranker code stays in-tree, inert unless CORPUS_RERANK=1.
  if (process.env.CORPUS_RERANK !== "1") {
    _registered = true; // mark done so we don't re-check every query
    return;
  }
  _registered = true; // set first so a throw can't cause a retry loop
  try {
    setCorpusReranker(new CrossEncoderReranker());
    // eslint-disable-next-line no-console
    console.info(`[corpus] cross-encoder reranker registered (modelId=${MODEL_REPO}, dtype=${DTYPE}). Reranking engages on the hybrid path; /api/corpus/status reports rerankerActive.`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[corpus] reranker registration failed; retrieval stays hybrid-only:", err);
  }
}

/** The reranker model identity this build bundles — exported so
 *  /api/corpus/status can report it to the UI. */
export const RERANKER_MODEL_ID = MODEL_REPO;
