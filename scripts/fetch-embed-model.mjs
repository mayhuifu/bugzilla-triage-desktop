// ─────────────────────────────────────────────────────────────────
// scripts/fetch-embed-model.mjs — stage the bge-small-en-v1.5 ONNX +
// tokenizer into ./models/ so electron-builder bundles it (v0.5 hybrid
// embedder). Run ONCE on a networked machine before `npm run dist:*`:
//
//     node scripts/fetch-embed-model.mjs            # q8 (~22 MB, default)
//     BGE_DTYPE=fp32 node scripts/fetch-embed-model.mjs   # full precision
//
// Downloads the raw HF repo files directly into the exact layout the
// runtime embedder (lib/corpus/embedder-bge.ts) expects:
//
//     models/Xenova/bge-small-en-v1.5/config.json
//     models/Xenova/bge-small-en-v1.5/tokenizer.json
//     models/Xenova/bge-small-en-v1.5/tokenizer_config.json
//     models/Xenova/bge-small-en-v1.5/onnx/model_quantized.onnx   (q8)
//     models/Xenova/bge-small-en-v1.5/onnx/model.onnx             (fp32)
//
// We download raw files (not via the Transformers.js cache) so the
// on-disk layout matches `env.localModelPath` semantics — with
// allowRemoteModels=false the runtime reads <localModelPath>/<repo>/<file>
// verbatim, so the directory tree MUST mirror the repo.
// ─────────────────────────────────────────────────────────────────

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "Xenova/bge-small-en-v1.5";
const REV = "main";
const DTYPE = (process.env.BGE_DTYPE || "q8").toLowerCase();
const BASE = `https://huggingface.co/${REPO}/resolve/${REV}`;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(root, "models", ...REPO.split("/"));

// Required for any dtype: model config + fast tokenizer + its config.
// Optional (downloaded if present): special tokens map, vocab.
// ONNX file depends on dtype.
const onnxFile = DTYPE === "fp32" ? "onnx/model.onnx" : "onnx/model_quantized.onnx";
const REQUIRED = ["config.json", "tokenizer.json", "tokenizer_config.json", onnxFile];
const OPTIONAL = ["special_tokens_map.json", "vocab.txt"];

// HuggingFace rate-limits (HTTP 429) and occasionally 5xxs, especially when
// the 3 CI runners (win/mac/linux) hit it within seconds of each other. A bare
// fetch with no retry then fails the whole release build. Retry transient
// statuses with exponential backoff + jitter (jitter decorrelates the runners).
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

console.log(`Staging ${REPO} (dtype=${DTYPE}) → ${dest}`);
fs.mkdirSync(dest, { recursive: true });
for (const f of REQUIRED) await fetchTo(f, true);
for (const f of OPTIONAL) await fetchTo(f, false);
console.log(`\nDone. The installer will bundle models/${REPO}/.`);
console.log(`Verify: ls -lh "${path.relative(root, dest)}"`);
