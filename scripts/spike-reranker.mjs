// Phase A de-risk spike — prove @huggingface/transformers can load a
// cross-encoder reranker and score (query, passage) pairs such that the
// clearly-correct passage outranks clear distractors, AND characterise how
// the model copes with 3GPP acronym↔expansion mismatch (informs model pick).
//
// Throwaway: not shipped. Run with `node scripts/spike-reranker.mjs`.
//   default            → Xenova/ms-marco-MiniLM-L-6-v2 (~23 MB q8)
//   RERANK_MODEL=Xenova/bge-reranker-base node scripts/spike-reranker.mjs
//
// Success criteria (PLAN-v0.5.5 Phase A, step 1):
//   - model + tokenizer load
//   - for each gating case, the correct passage scores #1. Passages are
//     "<title>. <text>" — exactly how the runtime reranker will feed them
//     (titles spell out terms the body abbreviates, which is load-bearing).
//   - a non-gating DIAGNOSTIC probe reports how the model handles a query
//     that uses spelled-out terms vs a passage that only uses the acronym.
//
// API note: Transformers.js has no turnkey "rerank" pipeline. A
// cross-encoder is a sequence-classification model with num_labels=1 whose
// single logit IS the relevance score. We tokenise the (query, passage)
// pair with `text_pair`, run the model, and read logits[:,0]. sigmoid() is
// monotone so it doesn't change ranking — we report both.

import { AutoTokenizer, AutoModelForSequenceClassification } from "@huggingface/transformers";

const MODEL = process.env.RERANK_MODEL || "Xenova/ms-marco-MiniLM-L-6-v2";
const DTYPE = process.env.RERANK_DTYPE || "q8";

const t0 = Date.now();
console.log(`[spike] loading ${MODEL} (dtype=${DTYPE}) …`);
const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
const model = await AutoModelForSequenceClassification.from_pretrained(MODEL, { dtype: DTYPE });
console.log(`[spike] model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

async function rerank(query, passages) {
  const inputs = await tokenizer(
    new Array(passages.length).fill(query),
    { text_pair: passages, padding: true, truncation: true },
  );
  const { logits } = await model(inputs);
  return logits.tolist().map((row) => row[0]); // num_labels===1 → [N,1]
}
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// Gating cases. The CORRECT passage is index 0. Passages are "<title>. <body>"
// to mirror the runtime reranker input (title carries the spelled-out term).
const CASES = [
  {
    query: "which timer governs handover failure detection",
    passages: [
      "Reconfiguration with sync. T304 is started upon reception of an RRCReconfiguration containing reconfigurationWithSync; if T304 expires the UE considers the handover to have failed and initiates RRC connection re-establishment.",
      "Physical downlink shared channel scrambling. The block of bits shall be scrambled prior to modulation using the scrambling sequence.",
      "Paging. In RRC_IDLE the UE monitors paging occasions according to the configured DRX cycle to reduce power consumption.",
    ],
  },
  {
    query: "maximum UE output power and its tolerance",
    passages: [
      "UE maximum output power. The configured UE maximum output power PCMAX shall be set within the bounds PCMAX_L and PCMAX_H; the maximum output power and its tolerance for the power class are specified in this clause.",
      "Random access procedure. Upon handover, the UE performs the random access procedure towards the target cell indicated in reconfigurationWithSync.",
      "Channel state information reporting. The UE reports CQI, PMI and RI on the configured PUCCH or PUSCH resources.",
    ],
  },
  {
    query: "scrambling of the physical downlink shared channel",
    passages: [
      "Physical downlink shared channel (PDSCH) scrambling. For PDSCH, the block of bits shall be scrambled prior to modulation, generating a block of scrambled bits using a scrambling sequence initialised with the RNTI and cell ID.",
      "Reconfiguration with sync. T304 is started upon reconfiguration with sync and on expiry the UE declares handover failure.",
      "Bandwidth part operation. The first active downlink and uplink bandwidth parts are applied when the UE performs reconfiguration with sync.",
    ],
  },
];

let allPass = true;
for (const { query, passages } of CASES) {
  const scores = await rerank(query, passages);
  const ranked = scores.map((s, i) => ({ i, s, p: sigmoid(s) })).sort((a, b) => b.s - a.s);
  const correctWins = ranked[0].i === 0;
  allPass = allPass && correctWins && scores.length === passages.length;
  console.log(`\n[spike] query: "${query}"`);
  for (const r of ranked) {
    console.log(`  ${r.s.toFixed(3).padStart(8)}  (p=${r.p.toFixed(4)})  [#${r.i}]${r.i === 0 ? " ← CORRECT" : ""}`);
  }
  console.log(`  → correct passage ranked #1: ${correctWins ? "yes ✅" : "no ❌"}`);
}

// ── DIAGNOSTIC (non-gating): pure acronym↔expansion bridging. Query spells
// the term out; one passage uses ONLY the acronym, one uses the expansion,
// one is unrelated. Reports whether the model bridges PDSCH↔"physical
// downlink shared channel" with NO title hint. This is what distinguishes a
// general MS-MARCO model from a stronger reranker on jargon. ──────────────
{
  const query = "scrambling of the physical downlink shared channel";
  const passages = [
    "For PDSCH the bits are scrambled prior to modulation using a scrambling sequence.", // acronym-only
    "For the physical downlink shared channel the bits are scrambled prior to modulation.", // expansion
    "The UE monitors paging occasions according to the DRX cycle.", // unrelated
  ];
  const labels = ["acronym-only(PDSCH)", "expansion", "unrelated"];
  const scores = await rerank(query, passages);
  const ranked = scores.map((s, i) => ({ i, s, p: sigmoid(s) })).sort((a, b) => b.s - a.s);
  console.log(`\n[spike] DIAGNOSTIC — acronym bridging (non-gating):`);
  for (const r of ranked) console.log(`  ${r.s.toFixed(3).padStart(8)}  (p=${r.p.toFixed(4)})  ${labels[r.i]}`);
  const bridges = scores[0] > scores[2]; // acronym-only beats unrelated?
  console.log(`  → bridges acronym→expansion (acronym-only > unrelated): ${bridges ? "yes" : "NO — needs title context / stronger model"}`);
}

console.log(`\n[spike] MODEL: ${MODEL}`);
console.log(`[spike] RESULT: ${allPass ? "PASS ✅" : "FAIL ❌"}`);
process.exit(allPass ? 0 : 1);
