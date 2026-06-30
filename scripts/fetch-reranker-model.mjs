// ─────────────────────────────────────────────────────────────────
// scripts/fetch-reranker-model.mjs — stage the cross-encoder reranker
// ONNX + tokenizer into ./models/ so electron-builder bundles it
// (next-gen RAG Phase A / v0.5.5). Run ONCE on a networked machine before
// `npm run dist:*`:
//
//     node scripts/fetch-reranker-model.mjs            # q8 (~23 MB, default)
//     RERANK_MODEL=Xenova/bge-reranker-base node scripts/fetch-reranker-model.mjs
//     RERANK_DTYPE=fp32 node scripts/fetch-reranker-model.mjs
//
// Mirrors fetch-embed-model.mjs exactly (raw HF file download into the
// localModelPath layout the runtime reranker reads with
// allowRemoteModels=false). The default is the tiny MS-MARCO MiniLM
// cross-encoder; override RERANK_MODEL to stage a stronger one for the eval
// A/B. MUST match lib/corpus/reranker-ce.ts's MODEL_REPO (same env var).
//
// Required layout (verified against the live HF repo):
//     models/<repo>/config.json
//     models/<repo>/tokenizer.json
//     models/<repo>/tokenizer_config.json
//     models/<repo>/onnx/model_quantized.onnx   (q8)
//     models/<repo>/onnx/model.onnx             (fp32)
// ─────────────────────────────────────────────────────────────────

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.env.RERANK_MODEL || "Xenova/ms-marco-MiniLM-L-6-v2";
const REV = "main";
const DTYPE = (process.env.RERANK_DTYPE || "q8").toLowerCase();
// Default to the hf-mirror.com mirror (huggingface.co downloads are unreliable
// from some networks, e.g. mainland China). Drop-in same-layout mirror; override
// with HF_ENDPOINT to switch back, e.g. `HF_ENDPOINT=https://huggingface.co`.
const HF_ENDPOINT = (process.env.HF_ENDPOINT || "https://hf-mirror.com").replace(/\/+$/, "");
const BASE = `${HF_ENDPOINT}/${REPO}/resolve/${REV}`;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(root, "models", ...REPO.split("/"));

const onnxFile = DTYPE === "fp32" ? "onnx/model.onnx" : "onnx/model_quantized.onnx";
const REQUIRED = ["config.json", "tokenizer.json", "tokenizer_config.json", onnxFile];
const OPTIONAL = ["special_tokens_map.json", "vocab.txt"];

// Retry transient HF rate-limits / 5xx with backoff + jitter (see
// fetch-embed-model.mjs for the rationale — CI runners hammer HF in parallel).
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function fetchWithRetry(url, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      if (i === attempts - 1) throw err;
      await sleep(Math.min(30000, 1000 * 2 ** i) + Math.floor(Math.random() * 1000));
      continue;
    }
    if (res.ok || !RETRYABLE.has(res.status) || i === attempts - 1) return res;
    const ra = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(ra) && ra > 0
      ? ra * 1000
      : Math.min(30000, 1000 * 2 ** i) + Math.floor(Math.random() * 1000);
    process.stdout.write(`(${res.status}, retry ${i + 1}/${attempts} in ${Math.round(waitMs / 1000)}s) `);
    await sleep(waitMs);
  }
  throw new Error(`unreachable retry loop for ${url}`);
}

async function fetchTo(rel, required) {
  const url = `${BASE}/${rel}`;
  const out = path.join(dest, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  process.stdout.write(`  ${rel} … `);
  const res = await fetchWithRetry(url);
  if (!res.ok) {
    if (required) throw new Error(`HTTP ${res.status} for ${url}`);
    console.log(`skip (${res.status})`);
    return;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(out, buf);
  console.log(`${(buf.length / 1e6).toFixed(2)} MB`);
}

console.log(`Staging reranker ${REPO} (dtype=${DTYPE}) → ${dest}`);
fs.mkdirSync(dest, { recursive: true });
for (const f of REQUIRED) await fetchTo(f, true);
for (const f of OPTIONAL) await fetchTo(f, false);
console.log(`\nDone. The installer will bundle models/${REPO}/.`);
console.log(`Verify: ls -lh "${path.relative(root, dest)}"`);
