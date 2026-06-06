// A/B: mammoth (v5) vs Docling on the figure/table-answer clauses.
// For each table-answer query, compare how well each parser's clause TEXT
// matches the query (bge-small cosine) + key-term coverage. Isolated: reads v5
// read-only, runs Docling sidecar to temp dirs (won't touch the live build).

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
const require = createRequire(import.meta.url);
const Database = require("/Users/huifu/bugzilla-triage-desktop/node_modules/better-sqlite3");

const WT = "/Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049";
const V5 = `${WT}/out/corpus.sqlite`;
const PY = "/tmp/docling-venv/bin/python";
const SIDECAR = `${WT}/scripts/parse_sidecar.py`;
const SPEC_DOCX = { "38.212": `${WT}/raw/38212-hd0.docx`, "38.321": `${WT}/raw/38321-hf0.docx` };
const TARGETS = [
  { spec: "38.321", clause: "7.1", id: "38.321#7.1",
    q: "Which RNTI hexadecimal value range should the UE treat as P-RNTI vs C-RNTI? gNB seems to be assigning a C-RNTI inside the reserved range.",
    terms: ["P-RNTI", "C-RNTI", "RA-RNTI", "FFFF", "FFFE", "0001"] },
  { spec: "38.321", clause: "6.2.1", id: "38.321#6.2.1",
    q: "MAC subheader on UL-SCH carries an unexpected LCID and the MAC CE is parsed as the wrong control element.",
    terms: ["LCID", "subheader", "UL-SCH", "Index"] },
  { spec: "38.212", clause: "7.3.1.1.2", id: "38.212#7.3.1.1.2",
    q: "DCI format 0_1 field sizes look off; the UE decodes the frequency-domain resource assignment field with the wrong number of bits.",
    terms: ["Frequency domain resource assignment", "Identifier for DCI formats", "bits"] },
];

function runSidecar(spec) {
  return new Promise((res, rej) => {
    const media = `/tmp/ab-media-${spec}`; fs.mkdirSync(media, { recursive: true });
    const p = spawn(PY, [SIDECAR, SPEC_DOCX[spec], media, `ab-${spec}`], { env: { ...process.env } });
    let out = "", err = ""; p.stdout.setEncoding("utf8");
    p.stdout.on("data", d => out += d); p.stderr.on("data", d => err += d);
    p.on("close", c => c === 0 ? res(JSON.parse(out)) : rej(new Error(err.slice(-300))));
  });
}
function flattenTable(rows) { return rows.map(r => r.map(c => (c || "").replace(/\s+/g, " ").trim()).join(" | ")).join("\n"); }
// Reconstruct a clause's body text from the Docling element stream, mirroring
// 02-parse buildBodyText: body = elements between this heading and the next.
function doclingClauseText(elements, clauseNo) {
  const hIdx = []; elements.forEach((e, i) => { if (e.kind === "heading") hIdx.push(i); });
  for (let k = 0; k < hIdx.length; k++) {
    const e = elements[hIdx[k]];
    if (e.clauseNo === clauseNo) {
      const body = elements.slice(hIdx[k] + 1, k + 1 < hIdx.length ? hIdx[k + 1] : elements.length);
      const parts = [];
      for (const el of body) {
        if (el.kind === "text") { const t = (el.text || "").trim(); if (t) parts.push(t); }
        else if (el.kind === "table") { const f = flattenTable(el.rows || []); if (f) parts.push(f); }
      }
      return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
    }
  }
  return "";
}
const termCov = (text, terms) => terms.filter(t => text.toLowerCase().includes(t.toLowerCase())).length;

const db = new Database(V5, { readonly: true });
const tf = await import("@huggingface/transformers");
const ex = await tf.pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8" });
const embed = async t => { const o = await ex(t.slice(0, 4000), { pooling: "cls", normalize: true }); return o.data; };
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

const docCache = {};
for (const spec of Object.keys(SPEC_DOCX)) { process.stderr.write(`[ab] docling ${spec}…\n`); docCache[spec] = await runSidecar(spec); }

console.log("\n================ A/B: mammoth (v5) vs Docling — table-answer clauses ================");
for (const t of TARGETS) {
  const mam = db.prepare("SELECT text FROM clauses WHERE id=?").get(t.id)?.text || "";
  const doc = doclingClauseText(docCache[t.spec], t.clause);
  const qv = await embed(t.q);
  const cMam = mam ? cos(qv, await embed(mam)) : 0;
  const cDoc = doc ? cos(qv, await embed(doc)) : 0;
  console.log(`\nqid → ${t.id}  «${t.q.slice(0, 60)}…»`);
  console.log(`  mammoth: ${mam.length} chars | term-cov ${termCov(mam, t.terms)}/${t.terms.length} | cos ${cMam.toFixed(4)}`);
  console.log(`  docling: ${doc.length} chars | term-cov ${termCov(doc, t.terms)}/${t.terms.length} | cos ${cDoc.toFixed(4)}`);
  const win = cDoc > cMam + 0.005 ? "DOCLING" : cMam > cDoc + 0.005 ? "mammoth" : "~tie";
  console.log(`  → query-match winner: ${win}  (Δcos ${(cDoc - cMam >= 0 ? "+" : "") + (cDoc - cMam).toFixed(4)})`);
}
db.close();
