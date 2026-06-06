// scripts/dev-relational-eval-gate.mjs — Phase C (v0.5.7) prerequisite gate.
//
// Answers: does a REAL relational failure mode exist for v5 + hybrid? i.e. are
// there multi-hop queries whose normative answer clause hybrid MISSES (answer
// outside top-10)? Those misses are the only thing a knowledge graph could
// recover — without them Phase C's KG is unjustified (as the reranker was).
//
// This is dev-kg-spike.mjs's plumbing (corpus + bge-small + production RRF CTE)
// with the KG removed: pure measurement, read-only. No LLM beyond the local
// bge-small ONNX query embedder. Run FROM the desktop repo:
//   node scripts/dev-relational-eval-gate.mjs [--candidates PATH] [--corpus PATH]
//        [--out PATH] [--filter-relational]
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = "/Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049";
const CORPUS = arg("--corpus", process.env.CORPUS || `${BASE}/out/corpus.sqlite`);
const CANDIDATES = arg("--candidates", process.env.CANDIDATES || `${BASE}/scripts/eval-queries-relational-candidates.json`);
const OUT = arg("--out", process.env.OUT || `${BASE}/dist/relational-gate-results.json`);
const FILTER_REL = argv.includes("--filter-relational");

// Production-faithful RRF params (verbatim from dev-kg-spike.mjs / retriever.ts).
const RRF_K = 60, PER_SOURCE = 80, POOL_N = 50; // POOL_N = what production keeps
const TOP = 10;     // answer in top-10 = HIT (handled)
const DEEP_N = 200; // how deep we report rank (fused candidate set caps ~2*PER_SOURCE)

const db = new Database(CORPUS, { readonly: true });
db.pragma("cache_size=-20000"); sqliteVec.load(db);
const embModel = db.prepare("SELECT value FROM meta WHERE key='embeddingModel'").pluck().get();
if (embModel !== "BAAI/bge-small-en-v1.5") {
  console.error(`FATAL: corpus embeddingModel=${embModel}, expected BAAI/bge-small-en-v1.5 — measurement invalid.`);
  process.exit(1);
}
const allIds = new Set(db.prepare("SELECT id FROM clauses").pluck().all());
console.log(`[gate] ${CORPUS} — ${allIds.size} clauses, embedder ${embModel}`);

const STOP = new Set(["the","and","for","that","this","with","from","when","have","been","are","was","were","will","into","but","not","you","your","our","their","its"]);
const toks = (t) => Array.from(new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(x => x.length >= 3 && x.length <= 32 && !STOP.has(x))));
const match = (t) => { const u = toks(t).slice(0, 60); return u.length ? u.map(x => `"${x.replace(/"/g, '""')}"`).join(" OR ") : '""'; };
const vecToBlob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const rrf = db.prepare(`
  WITH fts_top AS (SELECT c.rowid rowid, ROW_NUMBER() OVER (ORDER BY bm25(clauses_fts)) rk FROM clauses_fts JOIN clauses c ON c.rowid=clauses_fts.rowid WHERE clauses_fts MATCH ? LIMIT ?),
  vec_top AS (SELECT rowid, ROW_NUMBER() OVER (ORDER BY distance) rk FROM clauses_vec WHERE embedding MATCH ? AND k=?),
  fused AS (SELECT rowid, SUM(1.0/(?+rk)) s FROM (SELECT rowid,rk FROM fts_top UNION ALL SELECT rowid,rk FROM vec_top) GROUP BY rowid)
  SELECT c.id FROM fused JOIN clauses c ON c.rowid=fused.rowid ORDER BY fused.s DESC LIMIT ?`);

const tf = await import("@huggingface/transformers");
const extractor = await tf.pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8" });
const embed = async (t) => { const o = await extractor(t, { pooling: "cls", normalize: true }); return o.data instanceof Float32Array ? o.data : new Float32Array(o.data); };

const rankIn = (ids, target) => { const i = ids.indexOf(target); return i < 0 ? Infinity : i + 1; };
const bucket = (r) => r <= TOP ? "HIT" : r <= POOL_N ? "RANKED-LOW" : r <= DEEP_N ? "DEEP" : "MISS";

const doc = JSON.parse(fs.readFileSync(CANDIDATES, "utf8"));
let cands = doc.queries || doc;
if (FILTER_REL) cands = cands.filter(q => q.mode === "relational" || q.feature === "relational");
console.log(`[gate] ${cands.length} candidate queries from ${CANDIDATES}\n`);

const results = [];
let hard = 0, trueMiss = 0, phantoms = 0, hitAcc = 0, totalAcc = 0;
for (const q of cands) {
  const acc = (q.acceptableClauseIds && q.acceptableClauseIds.length) ? q.acceptableClauseIds : [q.expectedClauseId];
  const target = q.expectedClauseId || acc[0];
  const phantomIds = acc.filter(id => !allIds.has(id));
  if (phantomIds.length) { phantoms += phantomIds.length; console.log(`qid ${q.qid}: ⚠ PHANTOM: ${phantomIds.join(", ")}`); }
  const vec = await embed(q.query);
  const pool = rrf.all(match(q.query), PER_SOURCE, vecToBlob(vec), PER_SOURCE, RRF_K, DEEP_N).map(r => r.id);
  const ranks = {};
  for (const a of acc) { ranks[a] = rankIn(pool, a); totalAcc++; if (ranks[a] <= TOP) hitAcc++; }
  const tr = ranks[target] ?? Infinity;
  const isHard = tr > TOP, isTrueMiss = tr > POOL_N;
  if (isHard) hard++;
  if (isTrueMiss) trueMiss++;
  results.push({ qid: q.qid, query: q.query, target, ranks, bucket: bucket(tr), isHard, isTrueMiss, phantomIds });
  console.log(`qid ${q.qid} [${bucket(tr)}${isHard ? " ★HARD" : ""}] "${q.query.slice(0, 64)}…"`);
  for (const a of acc) console.log(`   ${a}: #${ranks[a] === Infinity ? "—" : ranks[a]}${a === target ? "  (target)" : ""}`);
  console.log("");
}

const summary = { total: cands.length, hard, handled: cands.length - hard, trueMiss, rerankable: hard - trueMiss, phantoms, acceptableInTop10: `${hitAcc}/${totalAcc}` };
console.log(`[gate] SUMMARY ${summary.total} candidates → ${hard} HARD (target outside top-${TOP}); of those ${trueMiss} TRUE-MISS (outside production pool of ${POOL_N} → KG territory), ${summary.rerankable} rerankable. acceptable-in-top10=${summary.acceptableInTop10}. phantoms=${phantoms}`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ generatedFrom: CANDIDATES, corpus: CORPUS, params: { RRF_K, PER_SOURCE, POOL_N, TOP, DEEP_N }, summary, results }, null, 2));
console.log(`[gate] wrote ${OUT}`);
db.close();
