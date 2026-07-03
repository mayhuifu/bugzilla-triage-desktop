// ─────────────────────────────────────────────────────────────────
// lib/corpus/embedder-bge.ts — the bundled query-time embedder that
// unlocks hybrid (BM25 ⊕ dense ⊕ RRF) retrieval on the desktop.
//
// The corpus records which embedding model built its vectors in
// meta.embeddingModel; the query-side embedder MUST be the same model
// or cosine similarities are meaningless. Two corpus generations exist:
//
//   rel17-v5/v6 → BAAI/bge-small-en-v1.5 (384-dim)  — bundled (~22 MB q8)
//   rel17-v7+   → BAAI/bge-m3           (1024-dim) — lazy-downloaded
//                 (~570 MB q8 int8 ONNX; too heavy to bundle in the
//                 installer — cached under the app-data dir on first use,
//                 per docs/desktop-port-retriever-v2.md §2)
//
// Registration is corpus-aware: ensureBgeEmbedderRegistered(corpusModel)
// picks the config matching the INSTALLED corpus and (re-)registers when
// the corpus generation changes in-process (e.g. a v6→v7 corpus update).
// Unknown corpus models register nothing → the retriever's hard-fail rule
// keeps retrieval FTS-only rather than silently mis-ranking.
//
// Implementation: @huggingface/transformers (Transformers.js v4) running
// the ONNX export. Both bge models want CLS pooling + L2 normalisation
// (bge-m3 dense head included — no instruction prefix, per the handoff).
//
// Loading strategy per model:
//   - PACKAGED/pre-staged: model files under <cwd>/models/<repo>/ via
//     electron-builder extraResources (scripts/fetch-embed-model.mjs).
//     env.localModelPath points there; no network.
//   - Otherwise: remote download allowed. Host defaults to hf-mirror.com
//     (drop-in HF mirror; huggingface.co LFS is unreliable from some
//     networks — same rationale as fetch-embed-model.mjs). Override with
//     HF_ENDPOINT. Downloads cache under <appData>/models-cache so the
//     ~570 MB bge-m3 fetch happens ONCE per machine, not per session.
//
// Everything here is best-effort: any failure leaves the embedder
// unregistered (or makes embed() throw, which the retriever catches and
// degrades to FTS-only). Hybrid is an enhancement, never a hard dependency.
// ─────────────────────────────────────────────────────────────────

import "server-only";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CorpusEmbedder } from "./embedder";
import { setCorpusEmbedder, getCorpusEmbedder } from "./embedder";
import { ensureEmbedderStaging, getEmbedderStageState } from "./embedder-stage";
import { appDataDir } from "../paths";

interface BgeModelConfig {
  /** Identity matched against the corpus's meta.embeddingModel. */
  modelId: string;
  /** HF repo Transformers.js actually loads (ONNX export namespace —
   *  same weights as the BAAI checkpoint, same embedding space). */
  repo: string;
  dim: number;
  defaultDtype: "q8" | "fp16" | "fp32";
}

const MODEL_CONFIGS: Record<string, BgeModelConfig> = {
  "BAAI/bge-small-en-v1.5": {
    modelId: "BAAI/bge-small-en-v1.5",
    repo: "Xenova/bge-small-en-v1.5",
    dim: 384,
    defaultDtype: "q8",
  },
  "BAAI/bge-m3": {
    modelId: "BAAI/bge-m3",
    repo: "Xenova/bge-m3",
    dim: 1024,
    defaultDtype: "q8", // int8-quantized ONNX ≈ 570 MB (handoff §2 option 1)
  },
};

/** Corpora older than rel17-v5 (or a missing meta row) are assumed
 *  bge-small — the only model desktop builds ever shipped before v7. */
const LEGACY_DEFAULT_MODEL = "BAAI/bge-small-en-v1.5";

// Quantisation override shared by both models: BGE_DTYPE=fp32 maximises
// fidelity against the fp16 corpus vectors at ~4× the download.
function dtypeFor(cfg: BgeModelConfig): "q8" | "fp16" | "fp32" {
  const env = (process.env.BGE_DTYPE || "").toLowerCase();
  return env === "fp32" || env === "fp16" || env === "q8" ? env : cfg.defaultDtype;
}

/** Resolve the staged-model directory for `repo`, checking (in order):
 *
 *   1. <cwd>/models/         — bundled by electron-builder (desktop) or
 *                              baked into the Docker image at build time.
 *   2. <appData>/models/     — staged by scripts/install-corpus.mjs on a
 *                              server (persistent /data volume) or by an
 *                              admin for fully-offline desktops.
 *
 *  config.json is the first file the runtime reads, so its presence is the
 *  reliable "staged" signal. Returns null when unstaged anywhere → the
 *  caller allows a remote (cached) download instead. */
function bundledModelRoot(repo: string): string | null {
  for (const root of [path.join(process.cwd(), "models"), path.join(appDataDir(), "models")]) {
    const cfg = path.join(root, ...repo.split("/"), "config.json");
    try {
      if (fs.existsSync(cfg)) return root;
    } catch { /* try next root / fall through to remote */ }
  }
  return null;
}


// Transformers.js pipeline type is loaded dynamically (ESM-only package),
// so we keep a loose type here rather than importing it at module scope.
type FeatureExtractor = (
  text: string,
  opts: { pooling: "cls" | "mean"; normalize: boolean },
) => Promise<{ data: ArrayLike<number> }>;

class BgeEmbedder implements CorpusEmbedder {
  readonly modelId: string;
  private readonly cfg: BgeModelConfig;
  private _pipe: Promise<FeatureExtractor> | null = null;

  constructor(cfg: BgeModelConfig) {
    this.cfg = cfg;
    this.modelId = cfg.modelId;
  }

  /** Lazily construct the feature-extraction pipeline exactly once. The
   *  heavy ONNX init happens on the FIRST embed() call, guarded by a
   *  single in-flight promise so concurrent first calls don't load the
   *  model twice.
   *
   *  NEVER downloads. When no staged/bundled model dir exists this kicks
   *  BACKGROUND staging (embedder-stage.ts: Range-resume, survives resets)
   *  and throws immediately — the retriever catches, degrades the query
   *  to FTS-only, and the search RETURNS instead of blocking behind a
   *  ~570 MB in-request download (which hung every /spec search on fresh
   *  v7 installs — the download restarted per query on flaky networks and
   *  never finished). Once staging completes, the next embed() finds the
   *  files and hybrid activates. */
  private pipe(): Promise<FeatureExtractor> {
    if (this._pipe) return this._pipe;
    this._pipe = (async () => {
      const dtype = dtypeFor(this.cfg);
      const root = bundledModelRoot(this.cfg.repo);
      if (!root) {
        ensureEmbedderStaging(this.cfg.repo, dtype);
        const st = getEmbedderStageState();
        const progress = st.status === "staging" && st.receivedBytes
          ? ` (${(st.receivedBytes / 1e6).toFixed(0)} MB so far)`
          : "";
        throw new Error(
          `query embedder ${this.cfg.repo} is not staged yet — background download ${st.status}${progress}; ` +
          `search runs keyword-only until it completes`,
        );
      }
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
      // NOTE: tf.env is module-global. If the corpus generation flips
      // in-process (v6→v7) the last-registered embedder's env wins —
      // fine, because the retriever only ever uses the embedder that
      // matches the CURRENT corpus.
      tf.env.localModelPath = root;
      tf.env.cacheDir = root;
      tf.env.allowRemoteModels = false;
      // eslint-disable-next-line no-console
      console.info(`[corpus] bge embedder: loading ${this.cfg.repo} (${dtype}) from staged ${root}`);
      const extractor = await tf.pipeline("feature-extraction", this.cfg.repo, { dtype });
      return extractor;
    })();
    // If the load fails (model unstaged / staged files corrupt), clear the
    // cached promise so a later call re-checks — staging may have finished
    // in the meantime.
    this._pipe.catch(() => { this._pipe = null; });
    return this._pipe;
  }

  async embed(text: string): Promise<Float32Array> {
    const extractor = await this.pipe();
    // Both bge models want CLS pooling + L2 normalisation (unit vectors —
    // required because sqlite-vec's L2 distance rank-orders identically to
    // cosine ONLY for normalized vectors). bge-m3 dense queries take no
    // instruction prefix (handoff §2).
    const out = await extractor(text, { pooling: "cls", normalize: true });
    const vec = out.data instanceof Float32Array ? out.data : new Float32Array(out.data);
    if (vec.length !== this.cfg.dim) {
      // Wrong model staged / corpus-dim mismatch. Throw so the retriever's
      // catch falls back to FTS-only (and logs) instead of pushing a
      // wrong-length blob into sqlite-vec (which would error or, worse,
      // silently mis-rank).
      throw new Error(`bge embedder produced ${vec.length} dims, expected ${this.cfg.dim} (${this.modelId})`);
    }
    // Defensive copy — out.data may be a view into a reused buffer.
    return new Float32Array(vec);
  }
}

let _registeredModelId: string | null = null;
let _warnedUnknownModel: string | null = null;

/** Register the query embedder matching the installed corpus so the
 *  retriever's hybrid path activates when meta.embeddingModel matches.
 *
 *  Idempotent per corpus model, synchronous, and best-effort — a failure
 *  NEVER throws into the retrieval hot path (the app keeps working
 *  FTS-only). Constructing the embedder does NOT load the ONNX model;
 *  that's deferred to the first embed() call.
 *
 *  `corpusModel` is the open corpus's meta.embeddingModel (null/undefined
 *  → legacy bge-small default). An unknown model unregisters the embedder
 *  entirely — the hard-fail rule from the handoff: never run dense
 *  retrieval with a mismatched embedding space.
 *
 *  Called lazily from the retriever's decidePath() rather than a Next.js
 *  instrumentation hook on purpose: instrumentation is compiled for the
 *  edge runtime too, where this module's node:fs / onnxruntime deps can't
 *  resolve. The retriever is node-only, so registering from it keeps
 *  everything on the node side. */
export function ensureBgeEmbedderRegistered(corpusModel?: string | null): void {
  const wanted = corpusModel ?? LEGACY_DEFAULT_MODEL;
  const cfg = MODEL_CONFIGS[wanted];
  if (!cfg) {
    // Corpus built with a model this desktop doesn't ship. Unregister so
    // the retriever's model-match gate disables dense paths (FTS-only).
    if (_registeredModelId !== null) {
      setCorpusEmbedder(null);
      _registeredModelId = null;
    }
    if (_warnedUnknownModel !== wanted) {
      _warnedUnknownModel = wanted;
      // eslint-disable-next-line no-console
      console.warn(
        `[corpus] corpus was built with embedding model '${wanted}', which this build has no query embedder for — ` +
        `dense retrieval DISABLED (FTS-only). Update the app to a version that bundles it.`,
      );
    }
    return;
  }
  if (_registeredModelId === cfg.modelId && getCorpusEmbedder()) return;
  try {
    setCorpusEmbedder(new BgeEmbedder(cfg));
    _registeredModelId = cfg.modelId;
    // eslint-disable-next-line no-console
    console.info(
      `[corpus] bge embedder registered (modelId=${cfg.modelId}, dim=${cfg.dim}, dtype=${dtypeFor(cfg)}). ` +
      `Hybrid engages when the installed corpus's meta.embeddingModel matches; /api/corpus/status reports the live state.`,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[corpus] bge embedder registration failed; retrieval stays FTS-only:", err);
  }
}

/** The model identity the ACTIVE embedder claims (null when none is
 *  registered — e.g. unknown corpus model). Exported so
 *  /api/corpus/status can report it alongside the corpus's
 *  meta.embeddingModel for the UI's "hybrid active vs fallback"
 *  indicator. */
export function activeQueryEmbedderModelId(): string | null {
  return getCorpusEmbedder()?.modelId ?? _registeredModelId;
}

/** Legacy constant — the model the DEFAULT (bundled) embedder claims.
 *  Prefer activeQueryEmbedderModelId() for live reporting. */
export const BGE_EMBEDDER_MODEL_ID = LEGACY_DEFAULT_MODEL;
