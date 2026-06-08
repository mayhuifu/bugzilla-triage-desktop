// ─────────────────────────────────────────────────────────────────
// scripts/dev-rerank-eval.mjs — measure the v0.5.5 cross-encoder rerank
// lift on a REAL corpus + eval set. Quantifies "ranked-low" recovery:
// MRR@10 / R@1 / R@10 for hybrid (BM25⊕dense⊕RRF) vs hybrid+rerank.
//
// This is the Phase A verification gate. It deliberately re-implements the
// production candidate generation (acronym expansion + NR/LTE bias + the
// exact RRF CTE from lib/corpus/retriever.ts) and the production rerank
// step (title-prefixed passage + cross-encoder), so the measured lift
// reflects what ships. It does NOT import the server-only retriever module
// (that throws outside Next.js); the logic is kept in sync by hand.
//
// Run (defaults point at the local rel17-v5 build + corpus eval set):
//   node scripts/dev-rerank-eval.mjs
//   CORPUS=/path/corpus.sqlite QUERIES=/path/eval-queries.json node scripts/dev-rerank-eval.mjs
//   RERANK_MODEL=Xenova/bge-reranker-base node scripts/dev-rerank-eval.mjs   # A/B a stronger model
// ─────────────────────────────────────────────────────────────────

import { createRequire } from "node:module";
import * as fs from "node:fs";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");

// ── Config ────────────────────────────────────────────────────────
const CORPUS = process.env.CORPUS
  || "/Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049/out/corpus.sqlite";
const QUERIES = process.env.QUERIES
  || "/Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049/scripts/eval-queries.json";
const RERANK_MODEL = process.env.RERANK_MODEL || "Xenova/ms-marco-MiniLM-L-6-v2";
const EMBED_MODEL = process.env.EMBED_MODEL || "Xenova/bge-small-en-v1.5";
const EMBED_DTYPE = process.env.EMBED_DTYPE || "q8";
const RERANK_DTYPE = process.env.RERANK_DTYPE || "q8";
// Mirror retriever.ts production constants.
const RRF_K = 60;
const CANDIDATES_PER_SOURCE = 50;
const RERANK_CANDIDATE_K = Number(process.env.CANDIDATE_K) || 30; // rerank window
const RERANK_MODE = process.env.RERANK_MODE || "replace";        // replace | fuse
const EXCLUDE_TEST_SPECS = process.env.EXCLUDE_TEST_SPECS === "1"; // drop conformance test specs from the pool
const TEST_SPEC_PENALTY = Number(process.env.TEST_SPEC_PENALTY ?? 1); // <1 = soft down-rank test specs (keep but demote)
// Conformance/test specs that flood the candidate pool with test-procedure
// clauses instead of the normative answer. None of the eval's expected
// answers live in these, so dropping them is pure de-pollution.
const TEST_SPEC_RE = /^(38\.523|36\.523|38\.521|36\.521|38\.508|36\.508)/;
const isTestSpec = (id) => TEST_SPEC_RE.test(String(id).split("#")[0]);
const POOL_N = Math.max(50, RERANK_CANDIDATE_K);                  // RRF pool size
const RERANK_QUERY_MAX_CHARS = 512;
const MAX_TEXT_CHARS = 1200;

// ── Query building (mirror lib/corpus/retriever.ts + acronyms.ts) ──
const STOPWORDS = new Set(["the","and","for","that","this","with","from","when","have","been","are","was","were","will","into","but","not","you","your","our","their","its","his","her","him","she","all","any","can","had","has","may","off","out","than","then"]);
const NR_HINTS = ["nr","5g","rnti","bwp","prb","redcap"];
const LTE_HINTS = ["lte","e-utra","eutra","epc","rlc-um"];

function tokenizeText(text) {
  return Array.from(new Set(
    text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)
      .filter(t => t.length >= 3 && t.length <= 32).filter(t => !STOPWORDS.has(t)),
  ));
}
function applyNrLteBias(tokens, blob) {
  const isNr = NR_HINTS.some(h => blob.includes(h));
  const isLte = LTE_HINTS.some(h => blob.includes(h));
  if (isNr && !isLte) return [...tokens, "nr", "nr"];
  if (isLte && !isNr) return [...tokens, "lte", "lte"];
  return tokens;
}
function expansionTokens(expansion) {
  return expansion.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/).filter(t => t.length >= 3);
}
function makeExpandAcronyms(db) {
  const cache = new Map();
  try {
    const rows = db.prepare("SELECT acronym, expansion, aliases FROM acronyms").all();
    for (const r of rows) {
      let aliases = [];
      try { const p = JSON.parse(r.aliases); if (Array.isArray(p)) aliases = p.filter(x => typeof x === "string"); } catch {}
      const entry = { expansion: r.expansion };
      cache.set(r.acronym.toLowerCase(), entry);
      for (const a of aliases) if (!cache.has(a.toLowerCase())) cache.set(a.toLowerCase(), entry);
    }
  } catch { /* v1 corpus — no table */ }
  return (tokens) => {
    if (cache.size === 0) return tokens;
    const seen = new Set(tokens.map(t => t.toLowerCase()));
    const extras = [];
    for (const t of tokens) {
      const hit = cache.get(t.toLowerCase());
      if (!hit) continue;
      for (const w of expansionTokens(hit.expansion)) if (!seen.has(w)) { seen.add(w); extras.push(w); }
    }
    return [...tokens, ...extras];
  };
}
function buildMatch(text, expandAcronyms) {
  const base = tokenizeText(text);
  const expanded = expandAcronyms(base);
  const biased = applyNrLteBias(expanded, text.toLowerCase());
  const uniq = Array.from(new Set(biased)).slice(0, 60);
  return uniq.length === 0 ? '""' : uniq.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}
function vecToBlob(v) { return Buffer.from(v.buffer, v.byteOffset, v.byteLength); }
function rerankPassage(c) {
  const head = c.parent_title ? `${c.parent_title} — ${c.title}` : c.title;
  const text = c.text.length > MAX_TEXT_CHARS ? c.text.slice(0, MAX_TEXT_CHARS) + "…" : c.text;
  return `${head}. ${text}`;
}

// ── Metrics ───────────────────────────────────────────────────────
// A query is satisfied if the top-ranked id is ANY of its acceptable clauses
// (acceptableClauseIds, falling back to [expectedClauseId]). This stops the
// metric from penalising a defensible sibling answer (e.g. the specific
// procedure clause vs the section's «General» stub).
function acceptableSet(q) {
  const a = Array.isArray(q.acceptableClauseIds) && q.acceptableClauseIds.length
    ? q.acceptableClauseIds : [q.expectedClauseId];
  return new Set(a);
}
function rankOfSet(ids, accept) {
  for (let i = 0; i < ids.length; i++) if (accept.has(ids[i])) return i + 1;
  return Infinity;
}
function summarize(ranks) {
  const n = ranks.length;
  const mrr10 = ranks.reduce((s, r) => s + (r <= 10 ? 1 / r : 0), 0) / n;
  const r1 = ranks.filter(r => r === 1).length / n;
  const r10 = ranks.filter(r => r <= 10).length / n;
  return { mrr10, r1, r10, n };
}
const pct = (x) => (x * 100).toFixed(1).padStart(5);

// ── Main ──────────────────────────────────────────────────────────
console.log(`[eval] corpus:  ${CORPUS}`);
console.log(`[eval] queries: ${QUERIES}`);
console.log(`[eval] config:  reranker=${RERANK_MODEL} mode=${RERANK_MODE} candidateK=${RERANK_CANDIDATE_K} poolN=${POOL_N}`);
const db = new Database(CORPUS, { readonly: true, fileMustExist: true });
db.pragma("cache_size = -20000");
sqliteVec.load(db);
const hasVec = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='clauses_vec'").get();
if (!hasVec) { console.error("[eval] corpus has no clauses_vec table — not a hybrid corpus. Abort."); process.exit(1); }
const embModel = db.prepare("SELECT value FROM meta WHERE key='embeddingModel'").get()?.value;
const schemaV = db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()?.value;
const total = db.prepare("SELECT COUNT(*) AS n FROM clauses").get().n;
console.log(`[eval] schemaVersion=${schemaV} embeddingModel=${embModel} clauses=${total}`);

const evalDoc = JSON.parse(fs.readFileSync(QUERIES, "utf8"));
const queries = (evalDoc.queries || []).filter(q => q.query && q.expectedClauseId);
console.log(`[eval] ${queries.length} eval queries`);

// Pre-check: at least one acceptable clause id must exist as a leaf.
const existsStmt = db.prepare("SELECT 1 FROM clauses WHERE id = ?");
const missing = queries.filter(q => ![...acceptableSet(q)].some(id => existsStmt.get(id)));
if (missing.length) {
  console.log(`[eval] ⚠ ${missing.length}/${queries.length} queries have NO acceptable clause id in corpus (miss in BOTH arms):`);
  for (const m of missing.slice(0, 12)) console.log(`        qid ${m.qid}: ${m.expectedClauseId}  (${m.stratum})`);
  if (missing.length > 12) console.log(`        … and ${missing.length - 12} more`);
}

const expandAcronyms = makeExpandAcronyms(db);

// RRF CTE — identical to lib/corpus/retriever.ts hybridRetrieve().
const rrfStmt = db.prepare(`
  WITH fts_top AS (
    SELECT c.rowid AS rowid, ROW_NUMBER() OVER (ORDER BY bm25(clauses_fts)) AS rk
    FROM clauses_fts JOIN clauses c ON c.rowid = clauses_fts.rowid
    WHERE clauses_fts MATCH ? LIMIT ?
  ),
  vec_top AS (
    SELECT rowid, ROW_NUMBER() OVER (ORDER BY distance) AS rk
    FROM clauses_vec WHERE embedding MATCH ? AND k = ?
  ),
  fused AS (
    SELECT rowid, SUM(1.0 / (? + rk)) AS rrf_score
    FROM (SELECT rowid, rk FROM fts_top UNION ALL SELECT rowid, rk FROM vec_top)
    GROUP BY rowid
  )
  SELECT c.id, c.title, c.parent_title, c.text, fused.rrf_score AS score
  FROM fused JOIN clauses c ON c.rowid = fused.rowid
  ORDER BY fused.rrf_score DESC LIMIT ?
`);

// ── Load models ───────────────────────────────────────────────────
console.log(`[eval] loading embedder ${EMBED_MODEL} (${EMBED_DTYPE}) + reranker ${RERANK_MODEL} (${RERANK_DTYPE}) …`);
const tf = await import("@huggingface/transformers");
const extractor = await tf.pipeline("feature-extraction", EMBED_MODEL, { dtype: EMBED_DTYPE });
const tokenizer = await tf.AutoTokenizer.from_pretrained(RERANK_MODEL);
const reranker = await tf.AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: RERANK_DTYPE });

async function embed(text) {
  const out = await extractor(text, { pooling: "cls", normalize: true });
  return out.data instanceof Float32Array ? out.data : new Float32Array(out.data);
}
async function rerankScores(query, passages) {
  const inputs = await tokenizer(new Array(passages.length).fill(query), { text_pair: passages, padding: true, truncation: true });
  const { logits } = await reranker(inputs);
  return logits.tolist().map(r => r[0]);
}

// ── Run eval ──────────────────────────────────────────────────────
const perStratum = {}; // stratum -> { hybrid:[], rerank:[] }
const hybridRanks = [], rerankRanks = [];
let t0 = Date.now();

for (let i = 0; i < queries.length; i++) {
  const q = queries[i];
  const match = buildMatch(q.query, expandAcronyms);
  let pool;
  try {
    const vec = await embed(q.query);
    // Fetch a generous pool so test-spec filtering still leaves ~POOL_N.
    const fetchN = EXCLUDE_TEST_SPECS ? Math.max(POOL_N * 3, 150) : POOL_N;
    let raw = rrfStmt.all(match, Math.max(CANDIDATES_PER_SOURCE, fetchN), vecToBlob(vec), Math.max(CANDIDATES_PER_SOURCE, fetchN), RRF_K, fetchN);
    if (EXCLUDE_TEST_SPECS) raw = raw.filter(r => !isTestSpec(r.id));
    if (TEST_SPEC_PENALTY < 1) {
      // Soft down-rank: keep test specs in the pool but multiply their RRF
      // score so normative clauses outrank them. Re-sort by adjusted score.
      raw = raw.map(r => ({ ...r, _adj: isTestSpec(r.id) ? r.score * TEST_SPEC_PENALTY : r.score }))
        .sort((a, b) => b._adj - a._adj);
    }
    pool = raw.slice(0, POOL_N);
  } catch (err) {
    console.warn(`[eval] qid ${q.qid} retrieval failed: ${err.message}`);
    pool = [];
  }
  // Hybrid arm: rank of first acceptable clause in the RRF-ordered pool.
  const accept = acceptableSet(q);
  const hybridIds = pool.map(r => r.id);
  const hRank = rankOfSet(hybridIds, accept);
  // Rerank arm: rerank the top-K of the pool (production window).
  const window = pool.slice(0, RERANK_CANDIDATE_K);
  let rRank = Infinity, reorderedRows = [];
  if (window.length > 0) {
    const rq = q.query.slice(0, RERANK_QUERY_MAX_CHARS);
    const scores = await rerankScores(rq, window.map(rerankPassage));
    const byScore = window.map((c, idx) => ({ ...c, s: Number.isFinite(scores[idx]) ? scores[idx] : -Infinity, rrfRank: idx + 1 }))
      .sort((a, b) => b.s - a.s);
    if (RERANK_MODE === "fuse") {
      // Robust rank fusion: combine the reranker order with the original RRF
      // order via RRF so a noisy reranker can't fully override hybrid.
      const rerankRankById = new Map(byScore.map((r, idx) => [r.id, idx + 1]));
      reorderedRows = window.map((c, idx) => ({
        ...c,
        s: 1 / (RRF_K + (idx + 1)) + 1 / (RRF_K + rerankRankById.get(c.id)),
      })).sort((a, b) => b.s - a.s);
    } else {
      reorderedRows = byScore;
    }
    rRank = rankOfSet(reorderedRows.map(x => x.id), accept);
  }
  if (process.env.DEBUG && i < (Number(process.env.DEBUG_N) || 6)) {
    const ex = db.prepare("SELECT id,title FROM clauses WHERE id=?").get(q.expectedClauseId);
    console.log(`\n── qid ${q.qid} [${q.stratum}] "${q.query}"`);
    console.log(`   expected: ${q.expectedClauseId}  «${ex?.title ?? "?"}»  (hybrid #${hRank}, rerank #${rRank})`);
    console.log(`   hybrid top5:  ${pool.slice(0,5).map((r,n)=>`${n+1}.${r.id}${r.id===q.expectedClauseId?"✓":""}`).join("  ")}`);
    console.log(`   rerank top5:  ${reorderedRows.slice(0,5).map((r,n)=>`${n+1}.${r.id}${r.id===q.expectedClauseId?"✓":""}(${r.s.toFixed(1)})`).join("  ")}`);
    console.log(`   rerank #1 title: «${reorderedRows[0]?.title ?? "?"}»`);
  }
  hybridRanks.push(hRank);
  rerankRanks.push(rRank);
  // GROUP_BY=mode breaks the per-stratum table down by retrieval mode
  // (top1/ranked-low/recall-miss/relational/normal) instead of subsystem —
  // the right lens for "does rerank help the ranked-low/relational cases?".
  const st = ((process.env.GROUP_BY === "mode" ? q.mode : q.stratum)) || "(none)";
  (perStratum[st] ??= { hybrid: [], rerank: [] });
  perStratum[st].hybrid.push(hRank);
  perStratum[st].rerank.push(rRank);
  if ((i + 1) % 10 === 0 || i === queries.length - 1) {
    process.stdout.write(`\r[eval] ${i + 1}/${queries.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)   `);
  }
}
console.log("");

// ── Report ────────────────────────────────────────────────────────
const H = summarize(hybridRanks), R = summarize(rerankRanks);
const d = (a, b) => { const x = (b - a) * 100; return (x >= 0 ? "+" : "") + x.toFixed(1); };
console.log(`\n══════════ Rerank eval — ${RERANK_MODEL} ══════════`);
console.log(`overall (n=${H.n})        MRR@10   R@1     R@10`);
console.log(`  hybrid (RRF)          ${pct(H.mrr10)}   ${pct(H.r1)}   ${pct(H.r10)}`);
console.log(`  hybrid + rerank       ${pct(R.mrr10)}   ${pct(R.r1)}   ${pct(R.r10)}`);
console.log(`  Δ (rerank − hybrid)   ${d(H.mrr10, R.mrr10).padStart(5)}   ${d(H.r1, R.r1).padStart(5)}   ${d(H.r10, R.r10).padStart(5)}  (pp)`);

console.log(`\nper-stratum MRR@10 / R@1 (hybrid → rerank):`);
for (const st of Object.keys(perStratum).sort()) {
  const a = summarize(perStratum[st].hybrid), b = summarize(perStratum[st].rerank);
  console.log(`  ${st.padEnd(10)} n=${String(a.n).padStart(2)}  MRR ${pct(a.mrr10)}→${pct(b.mrr10)} (${d(a.mrr10, b.mrr10)})   R@1 ${pct(a.r1)}→${pct(b.r1)} (${d(a.r1, b.r1)})`);
}

// How many queries did rerank specifically RESCUE (was >1, became 1) vs hurt?
let rescued = 0, hurt = 0, movedUp = 0, movedDown = 0;
for (let i = 0; i < hybridRanks.length; i++) {
  const h = hybridRanks[i], r = rerankRanks[i];
  if (h > 1 && r === 1) rescued++;
  if (h === 1 && r > 1) hurt++;
  if (r < h) movedUp++; else if (r > h) movedDown++;
}
console.log(`\nrerank effect: rescued-to-#1 ${rescued}, demoted-from-#1 ${hurt}, moved-up ${movedUp}, moved-down ${movedDown}`);
console.log(`(ranked-low recovery is the headline: hybrid R@1 ${pct(H.r1)}% → rerank R@1 ${pct(R.r1)}%)`);

db.close();
