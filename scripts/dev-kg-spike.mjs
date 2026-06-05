// scripts/dev-kg-spike.mjs — Phase C (v0.5.7) gating spike.
//
// Question: can a DETERMINISTIC (no-LLM) knowledge graph — entities from the
// `acronyms` table, clause↔entity links by matching acronyms in clause text,
// edges = shared-entity + clause hierarchy — recover the multi-hop second
// clause on RELATIONAL queries that plain hybrid retrieval misses?
//
// If yes, Phase C's relational win is achievable with NO build-time LLM (the
// LLM-typed edges become optional enrichment, exactly like Phase B's VLM
// captions vs the free spec captions).
//
// Reuses the rel17-v5 corpus + bge-small + the production RRF CTE. Run:
//   node scripts/dev-kg-spike.mjs

import { createRequire } from "node:module";
import * as fs from "node:fs";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");

const CORPUS = process.env.CORPUS || "/Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049/out/corpus.sqlite";
const QUERIES = process.env.QUERIES || "/Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049/scripts/eval-queries.json";
const RRF_K = 60, PER_SOURCE = 80, POOL_N = 50, EXPAND_HOPS_FROM = 8, EXPAND_MAX = 20;

const db = new Database(CORPUS, { readonly: true });
db.pragma("cache_size=-20000"); sqliteVec.load(db);

// ── Build deterministic KG ────────────────────────────────────────
// Entities = acronyms (+ aliases). Match WHOLE-WORD against clause title+text.
const acro = db.prepare("SELECT acronym, expansion, aliases FROM acronyms").all();
const entities = []; // {key, forms:[regex sources]}
for (const a of acro) {
  const forms = [a.acronym];
  try { const al = JSON.parse(a.aliases); if (Array.isArray(al)) forms.push(...al.filter(x => typeof x === "string")); } catch {}
  // Match the acronym token itself (uppercase, word-bounded). Skip ultra-generic
  // 1-char forms. Expansions are too noisy to match verbatim, so entity detection
  // keys on the acronym/alias tokens (3GPP text uses them heavily).
  const esc = (f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pats = forms.filter(f => f.length >= 2).map(esc);
  // reAcr: acronym/alias tokens, word-bounded, case-SENSITIVE (3GPP acronyms are
  // uppercase; avoids matching "as"/"is"). reExp: the spelled-out expansion,
  // case-insensitive — catches queries/clauses that write the term out
  // ("Buffer Status Report" → BSR). Only for specific (≥10-char) expansions.
  const reAcr = pats.length ? new RegExp(`\\b(?:${pats.join("|")})\\b`) : null;
  const exp = (a.expansion || "").trim();
  const reExp = exp.length >= 10 ? new RegExp(`\\b${esc(exp.toLowerCase())}\\b`) : null;
  if (reAcr) entities.push({ key: a.acronym.toUpperCase(), reAcr, reExp });
}
console.log(`[kg] ${entities.length} entity nodes from acronyms`);

const clauses = db.prepare("SELECT id, parent_id, title, text FROM clauses").all();
const clauseEnts = new Map();      // clauseId -> Set(entityKey)
const entClauses = new Map();      // entityKey -> Set(clauseId)
const docFreq = new Map();         // entityKey -> #clauses (for IDF weighting)
for (const c of clauses) {
  const hay = `${c.title}\n${c.text}`;
  const hayLower = hay.toLowerCase();
  const set = new Set();
  for (const e of entities) if (e.reAcr.test(hay) || (e.reExp && e.reExp.test(hayLower))) set.add(e.key);
  clauseEnts.set(c.id, set);
  for (const k of set) {
    (entClauses.get(k) || entClauses.set(k, new Set()).get(k)).add(c.id);
    docFreq.set(k, (docFreq.get(k) || 0) + 1);
  }
}
const N = clauses.length;
const idf = (k) => Math.log(1 + N / (1 + (docFreq.get(k) || 0))); // rare entity = stronger edge
const childByParent = new Map();
for (const c of clauses) if (c.parent_id) (childByParent.get(c.parent_id) || childByParent.set(c.parent_id, []).get(c.parent_id)).push(c.id);
const parentOf = new Map(clauses.map(c => [c.id, c.parent_id]));
const avgEnts = [...clauseEnts.values()].reduce((a, s) => a + s.size, 0) / N;
console.log(`[kg] clause↔entity links built; avg ${avgEnts.toFixed(1)} entities/clause`);

// ── Hybrid retrieval (mirror production) ──────────────────────────
const STOP = new Set(["the","and","for","that","this","with","from","when","have","been","are","was","were","will","into","but","not","you","your","our","their","its"]);
function toks(t){return Array.from(new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu," ").split(/\s+/).filter(x=>x.length>=3&&x.length<=32&&!STOP.has(x))));}
function match(t){const u=toks(t).slice(0,60);return u.length?u.map(x=>`"${x.replace(/"/g,'""')}"`).join(" OR "):'""';}
function vecToBlob(v){return Buffer.from(v.buffer,v.byteOffset,v.byteLength);}
const rrf = db.prepare(`
  WITH fts_top AS (SELECT c.rowid rowid, ROW_NUMBER() OVER (ORDER BY bm25(clauses_fts)) rk FROM clauses_fts JOIN clauses c ON c.rowid=clauses_fts.rowid WHERE clauses_fts MATCH ? LIMIT ?),
  vec_top AS (SELECT rowid, ROW_NUMBER() OVER (ORDER BY distance) rk FROM clauses_vec WHERE embedding MATCH ? AND k=?),
  fused AS (SELECT rowid, SUM(1.0/(?+rk)) s FROM (SELECT rowid,rk FROM fts_top UNION ALL SELECT rowid,rk FROM vec_top) GROUP BY rowid)
  SELECT c.id FROM fused JOIN clauses c ON c.rowid=fused.rowid ORDER BY fused.s DESC LIMIT ?`);

const tf = await import("@huggingface/transformers");
const extractor = await tf.pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8" });
const embed = async (t) => { const o = await extractor(t, { pooling: "cls", normalize: true }); return o.data instanceof Float32Array ? o.data : new Float32Array(o.data); };

function detectEntities(text){ const hay=text, hl=text.toLowerCase(); const out=new Set(); for(const e of entities) if(e.reAcr.test(hay)||(e.reExp&&e.reExp.test(hl))) out.add(e.key); return out; }

// KG-augmented re-rank: RRF-fuse the hybrid order with a KG-connection order.
// kgScore(clause) = Σ idf(seed entity it shares) + hierarchy-sibling bonus,
// where seed entities = query entities ∪ entities of the top hybrid hits.
// Candidates = hybrid pool ∪ strongly-connected clauses (recall recovery).
// Final = 1/(K+hybridRank) + 1/(K+kgRank) — promotes clauses strong in EITHER
// signal, so a KG-connected pool clause ranked low gets pulled up.
function rerankWithKg(query, pool) {
  const seedEnts = new Set(detectEntities(query));
  for (const id of pool.slice(0, EXPAND_HOPS_FROM)) for (const k of (clauseEnts.get(id) || [])) seedEnts.add(k);
  const sibs = new Set();
  for (const id of pool.slice(0, EXPAND_HOPS_FROM)) { const p = parentOf.get(id); if (p) for (const s of (childByParent.get(p) || [])) sibs.add(s); }
  const kgScore = (cid) => {
    let s = 0; const ce = clauseEnts.get(cid) || new Set();
    for (const k of seedEnts) if (ce.has(k)) s += idf(k);
    if (sibs.has(cid)) s += 1.0;
    return s;
  };
  // Candidate set: the hybrid pool + the top KG-connected clauses outside it
  // (capped → recall recovery without flooding).
  const cand = new Set(pool);
  const connected = [];
  for (const k of seedEnts) for (const cid of (entClauses.get(k) || [])) if (!cand.has(cid)) connected.push(cid);
  for (const cid of sibs) if (!cand.has(cid)) connected.push(cid);
  for (const cid of [...new Set(connected)].map(cid => [cid, kgScore(cid)]).sort((a,b)=>b[1]-a[1]).slice(0, EXPAND_MAX)) cand.add(cid[0]);
  const poolRank = new Map(pool.map((id, i) => [id, i + 1]));
  const byKg = [...cand].map(cid => [cid, kgScore(cid)]).sort((a,b)=>b[1]-a[1]);
  const kgRank = new Map(byKg.map(([cid], i) => [cid, i + 1]));
  return [...cand].map(cid => [cid, 1/(RRF_K+(poolRank.get(cid)||POOL_N+EXPAND_MAX)) + 1/(RRF_K+kgRank.get(cid))])
    .sort((a,b)=>b[1]-a[1]).map(e => e[0]);
}

// ── Evaluate relational queries ───────────────────────────────────
const doc = JSON.parse(fs.readFileSync(QUERIES, "utf8"));
const rel = (doc.queries || []).filter(q => q.feature === "relational" || q.mode === "relational");
console.log(`[kg] evaluating ${rel.length} relational queries\n`);

const rankIn = (ids, target) => { const i = ids.indexOf(target); return i < 0 ? Infinity : i + 1; };
let hybridFound = 0, kgFound = 0, totalAcc = 0;
for (const q of rel) {
  const vec = await embed(q.query);
  const pool = rrf.all(match(q.query), PER_SOURCE, vecToBlob(vec), PER_SOURCE, RRF_K, POOL_N).map(r => r.id);
  const merged = rerankWithKg(q.query, pool);
  const acc = q.acceptableClauseIds;
  console.log(`qid ${q.qid}: "${q.query.slice(0, 66)}…"`);
  console.log(`   query entities: ${[...detectEntities(q.query)].join(", ") || "(none)"}`);
  for (const a of acc) {
    const h = rankIn(pool, a), m = rankIn(merged, a);
    totalAcc++;
    if (h <= 10) hybridFound++;
    if (m <= 10) kgFound++;
    const tag = (h > 10 && m <= 10) ? "✅ RECOVERED" : (h <= 10 && m > 10) ? "⚠ DROPPED" : "";
    console.log(`   ${a}: hybrid #${h===Infinity?"—":h}  →  +kg #${m===Infinity?"—":m}  ${tag}`);
  }
  console.log("");
}
console.log(`[kg] acceptable clauses in top-10:  hybrid ${hybridFound}/${totalAcc}  →  hybrid+kg ${kgFound}/${totalAcc}`);
db.close();
