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
const BASE = `https://huggingface.co/${REPO}/resolve/${REV}`;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(root, "models", ...REPO.split("/"));

const onnxFile = DTYPE === "fp32" ? "onnx/model.onnx" : "onnx/model_quantized.onnx";
const REQUIRED = ["config.json", "tokenizer.json", "tokenizer_config.json", onnxFile];
const OPTIONAL = ["special_tokens_map.json", "vocab.txt"];

async function fetchTo(rel, required) {
  const url = `${BASE}/${rel}`;
  const out = path.join(dest, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  process.stdout.write(`  ${rel} … `);
  const res = await fetch(url);
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
