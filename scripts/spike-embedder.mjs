// Phase 0 de-risk spike — prove @huggingface/transformers can load
// bge-small-en-v1.5 and produce a 384-dim, L2-normalised vector.
//
// Throwaway: not shipped. Run with `node scripts/spike-embedder.mjs`.
// First run downloads the ONNX model from the HF hub (~30 MB quantised).
//
// Success criteria (from PLAN-v0.5 Phase 0):
//   - output length === 384
//   - L2 norm ≈ 1.0  (bge wants normalised embeddings)
//   - two semantically-close strings score higher cosine than a far pair

import { pipeline } from "@huggingface/transformers";

function l2norm(arr) {
  let s = 0;
  for (const v of arr) s += v * v;
  return Math.sqrt(s);
}
function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // both already L2-normalised → dot === cosine
}

const MODEL = "Xenova/bge-small-en-v1.5"; // Transformers.js-compatible ONNX export

const t0 = Date.now();
console.log(`[spike] loading ${MODEL} …`);
const extractor = await pipeline("feature-extraction", MODEL, {
  dtype: "q8", // quantised → ~22 MB; what we'd bundle
});
console.log(`[spike] model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

async function embed(text) {
  const out = await extractor(text, { pooling: "cls", normalize: true });
  return Array.from(out.data);
}

const queries = [
  "BWP switching fails after handover to SA target cell",
  "bandwidth part reconfiguration during handover in standalone NR",
  "UE battery drains quickly in idle mode", // far/unrelated
];

const vecs = [];
for (const q of queries) {
  const t = Date.now();
  const v = await embed(q);
  vecs.push(v);
  console.log(
    `[spike] dim=${v.length} L2=${l2norm(v).toFixed(4)} (${Date.now() - t}ms) :: "${q}"`,
  );
}

console.log("\n[spike] cosine similarities:");
console.log(`  q0~q1 (close):   ${cosine(vecs[0], vecs[1]).toFixed(4)}`);
console.log(`  q0~q2 (far):     ${cosine(vecs[0], vecs[2]).toFixed(4)}`);

const ok =
  vecs.every((v) => v.length === 384) &&
  vecs.every((v) => Math.abs(l2norm(v) - 1) < 1e-3) &&
  cosine(vecs[0], vecs[1]) > cosine(vecs[0], vecs[2]);

console.log(`\n[spike] RESULT: ${ok ? "PASS ✅" : "FAIL ❌"}`);
process.exit(ok ? 0 : 1);
