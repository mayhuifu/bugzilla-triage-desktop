// ─────────────────────────────────────────────────────────────────
// lib/corpus/embedder-bge.ts — the bundled query-time embedder that
// unlocks hybrid (BM25 ⊕ dense ⊕ RRF) retrieval on the desktop.
//
// Corpus rel17-v5 is built with BAAI/bge-small-en-v1.5 (384-dim) at
// build time (recorded in meta.embeddingModel). To do hybrid retrieval
// at query time we need a vector for the bug/search text in the SAME
// embedding space — i.e. produced by the same model. This module is
// that query-side counterpart.
//
// Implementation: @huggingface/transformers (Transformers.js v4) running
// the ONNX export of bge-small-en-v1.5. Transformers.js bundles BERT
// WordPiece tokenisation + ONNX Runtime + model loading in one package,
// so this is a single dependency rather than raw onnxruntime-node + a
// hand-rolled tokenizer.
//
// Loading strategy (the packaging-risk surface — see PLAN-v0.5 Phase 0):
//   - PACKAGED build: the model files are bundled under
//     <cwd>/models/<MODEL_REPO>/ via electron-builder extraResources.
//     env.localModelPath points there and env.allowRemoteModels=false so
//     the app NEVER hits the network for the model.
//   - DEV (`npm run dev`): if the bundled dir is absent we allow remote
//     download from the HF hub (Transformers.js caches it locally), so a
//     developer can test hybrid without pre-staging the model.
//
// Everything here is best-effort: any failure leaves the embedder
// unregistered (or makes embed() throw, which the retriever catches and
// degrades to BM25). Hybrid is an enhancement, never a hard dependency.
// ─────────────────────────────────────────────────────────────────

import "server-only";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CorpusEmbedder } from "./embedder";
import { setCorpusEmbedder } from "./embedder";
// NOTE: deliberately do NOT import ./store here. instrumentation.ts imports
// this module, and Next.js compiles instrumentation for the edge runtime as
// well as node — a static import of store.ts would drag better-sqlite3 (→
// `bindings` → `fs`) into the edge bundle, which has no `fs`, and the build
// fails. The corpus-vs-embedder model comparison is logged elsewhere: the
// retriever's decidePath() warns per-query on mismatch, and
// /api/corpus/status reports hybridActive to the UI (both run in node-only
// route handlers where store.ts is safe to import).

// ── Model identity ────────────────────────────────────────────────
//
// MODEL_ID is the string matched against the corpus's meta.embeddingModel
// by the retriever's decidePath(). It MUST equal what the corpus build
// pipeline records — the corpus is built by sentence-transformers loading
// "BAAI/bge-small-en-v1.5", so that's the identity we claim.
//
// MODEL_REPO is the folder/repo Transformers.js actually loads. The ONNX
// export lives under the Xenova namespace; it's the same weights as the
// BAAI checkpoint, so the produced vectors share the embedding space.
// (Decoupling the two lets the on-disk folder differ from the corpus's
// identity string without breaking the modelId match.)
const MODEL_ID = "BAAI/bge-small-en-v1.5";
const MODEL_REPO = "Xenova/bge-small-en-v1.5";
const EMBED_DIM = 384;

// Quantisation of the bundled ONNX. "q8" keeps the bundle ~22 MB (the
// PLAN-v0.5 size budget); "fp32" (~130 MB) maximises fidelity against the
// fp32 corpus vectors. Overridable so the eval gate (corpus Phase 1) can
// pick whichever gives the better measured lift.
const DTYPE = (process.env.BGE_DTYPE || "q8") as "q8" | "fp16" | "fp32";

/** Resolve the bundled-model directory if it has been staged. In the
 *  packaged app the Next.js standalone server runs with
 *  cwd = <resources>/app/.next/standalone and electron-builder copies the
 *  model to <cwd>/models/<MODEL_REPO>/. We only check that the model's
 *  config.json exists at the expected localModelPath layout — that's the
 *  exact file the runtime reads first, so its presence is the reliable
 *  "model is staged" signal. Returns null when unstaged (dev, or a build
 *  where fetch-embed-model.mjs wasn't run) so the caller allows a remote
 *  download instead. */
function bundledModelRoot(): string | null {
  const root = path.join(process.cwd(), "models");
  const cfg = path.join(root, ...MODEL_REPO.split("/"), "config.json");
  try {
    if (fs.existsSync(cfg)) return root;
  } catch { /* fall through to remote */ }
  return null;
}

// Transformers.js pipeline type is loaded dynamically (ESM-only package),
// so we keep a loose type here rather than importing it at module scope.
type FeatureExtractor = (
  text: string,
  opts: { pooling: "cls" | "mean"; normalize: boolean },
) => Promise<{ data: ArrayLike<number> }>;

class BgeEmbedder implements CorpusEmbedder {
  readonly modelId = MODEL_ID;
  private _pipe: Promise<FeatureExtractor> | null = null;

  /** Lazily construct the feature-extraction pipeline exactly once. The
   *  heavy ONNX init happens on the FIRST embed() call (not at app boot),
   *  guarded by a single in-flight promise so concurrent first calls
   *  don't load the model twice. */
  private pipe(): Promise<FeatureExtractor> {
    if (this._pipe) return this._pipe;
    this._pipe = (async () => {
      // Dynamic import — @huggingface/transformers is ESM-only and is
      // externalized in next.config.mjs (loaded from the unpacked
      // standalone node_modules, never webpack-bundled).
      const tf = (await import("@huggingface/transformers")) as unknown as {
        pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<FeatureExtractor>;
        env: {
          allowRemoteModels: boolean;
          localModelPath: string;
          cacheDir: string;
          backends: { onnx: Record<string, unknown> };
        };
      };
      const root = bundledModelRoot();
      if (root) {
        // Packaged / pre-staged: offline, load from disk only. Point both
        // localModelPath (where local files are read) and cacheDir (no
        // remote, but harmless to align) at the bundled dir.
        tf.env.localModelPath = root;
        tf.env.cacheDir = root;
        tf.env.allowRemoteModels = false;
        // eslint-disable-next-line no-console
        console.info(`[corpus] bge embedder: loading ${MODEL_REPO} (${DTYPE}) from bundled ${root}`);
      } else {
        // Dev fallback: let Transformers.js download + cache from the hub.
        // eslint-disable-next-line no-console
        console.info(`[corpus] bge embedder: no bundled model dir; allowing remote download of ${MODEL_REPO} (${DTYPE})`);
      }
      const extractor = await tf.pipeline("feature-extraction", MODEL_REPO, { dtype: DTYPE });
      return extractor;
    })();
    // If the first load fails, clear the cached promise so a later call
    // can retry (e.g. corpus downloaded after a transient model-load error).
    this._pipe.catch(() => { this._pipe = null; });
    return this._pipe;
  }

  async embed(text: string): Promise<Float32Array> {
    const extractor = await this.pipe();
    // bge wants CLS pooling + L2 normalisation to produce the unit vectors
    // cosine similarity expects. normalize:true makes ‖v‖₂ ≈ 1.
    const out = await extractor(text, { pooling: "cls", normalize: true });
    const vec = out.data instanceof Float32Array ? out.data : new Float32Array(out.data);
    if (vec.length !== EMBED_DIM) {
      // Wrong model bundled / corpus-dim mismatch. Throw so the retriever's
      // hybridRetrieve catch falls back to BM25 (and logs) instead of
      // pushing a wrong-length blob into sqlite-vec (which would error or,
      // worse, silently mis-rank).
      throw new Error(`bge embedder produced ${vec.length} dims, expected ${EMBED_DIM}`);
    }
    // Defensive copy — out.data may be a view into a reused buffer.
    return new Float32Array(vec);
  }
}

let _registered = false;

/** Register the bundled bge embedder so the retriever's hybrid path
 *  activates when the open corpus's meta.embeddingModel matches MODEL_ID.
 *
 *  Idempotent, synchronous, and best-effort — a failure NEVER throws into
 *  the retrieval hot path (the app keeps working BM25-only). Constructing
 *  the embedder does NOT load the ~22 MB ONNX model; that's deferred to the
 *  first embed() call.
 *
 *  Called lazily from the retriever's decidePath() rather than a Next.js
 *  instrumentation hook on purpose: instrumentation.ts is compiled for the
 *  edge runtime too, and this module's `node:fs` / onnxruntime-node deps
 *  can't resolve there. The retriever is node-only (it imports better-
 *  sqlite3), so registering from it keeps everything on the node side. */
export function ensureBgeEmbedderRegistered(): void {
  if (_registered) return;
  _registered = true; // set first so a throw can't cause a retry loop
  try {
    setCorpusEmbedder(new BgeEmbedder());
    // eslint-disable-next-line no-console
    console.info(`[corpus] bge embedder registered (modelId=${MODEL_ID}, dtype=${DTYPE}). Hybrid engages when the installed corpus's meta.embeddingModel matches; otherwise decidePath() logs a one-line BM25-fallback notice. /api/corpus/status reports the live hybridActive state.`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[corpus] bge embedder registration failed; retrieval stays BM25-only:", err);
  }
}

/** The model identity this embedder claims — exported so /api/corpus/status
 *  can report it alongside the corpus's meta.embeddingModel for the UI's
 *  "hybrid active vs fallback" indicator. */
export const BGE_EMBEDDER_MODEL_ID = MODEL_ID;
