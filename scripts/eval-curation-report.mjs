// scripts/eval-curation-report.mjs — objective input for curating a verified
// eval set. For each query in eval-queries.json, against the local corpus
// (with v0.5.5 test-spec demotion applied), report:
//   - does expectedClauseId exist? is it a leaf?
//   - rank of expected in the demoted-hybrid pool (or "miss")
//   - the demoted-hybrid top-10 (id + title) so a human/agent can choose
//     acceptable answers and detect mislabels.
// Writes JSON to REPORT (default dist/eval-curation-report.json) + prints a
// compact table. No reranker — this characterises retrieval ground truth.
//
//   node scripts/eval-curation-report.mjs
//   CORPUS=… QUERIES=… REPORT=… node scripts/eval-curation-report.mjs

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");

const CORPUS = process.env.CORPUS || "/Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049/out/corpus.sqlite";
const QUERIES = process.env.QUERIES || "/Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049/scripts/eval-queries.json";
const REPORT = process.env.REPORT || path.join(process.cwd(), "dist", "eval-curation-report.json");
const RRF_K = 60, PER_SOURCE = 150, POOL_N = 50;
const TEST_SPEC_RE = /^(?:38\.523|36\.523|38\.521|36\.521|38\.508|36\.508)\b/;
const isTestSpec = (id) => TEST_SPEC_RE.test(String(id).split("#")[0]);

const STOPWORDS = new Set(["the","and","for","that","this","with","from","when","have","been","are","was","were","will","into","but","not","you","your","our","their","its","his","her","him","she","all","any","can","had","has","may","off","out","than","then"]);
const NR_HINTS = ["nr","5g","rnti","bwp","prb","redcap"], LTE_HINTS = ["lte","e-utra","eutra","epc","rlc-um"];
function tokenize(t){return Array.from(new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu," ").split(/\s+/).filter(x=>x.length>=3&&x.length<=32).filter(x=>!STOPWORDS.has(x))));}
function bias(tokens,blob){const nr=NR_HINTS.some(h=>blob.includes(h)),lte=LTE_HINTS.some(h=>blob.includes(h));if(nr&&!lte)return[...tokens,"nr","nr"];if(lte&&!nr)return[...tokens,"lte","lte"];return tokens;}
function expTokens(e){return e.toLowerCase().replace(/\([^)]*\)/g," ").replace(/[^\p{L}\p{N}\s-]/gu," ").split(/\s+/).filter(x=>x.length>=3);}
function mkExpand(db){const c=new Map();try{for(const r of db.prepare("SELECT acronym,expansion,aliases FROM acronyms").all()){let al=[];try{const p=JSON.parse(r.aliases);if(Array.isArray(p))al=p.filter(x=>typeof x==="string");}catch{}c.set(r.acronym.toLowerCase(),{expansion:r.expansion});for(const a of al)if(!c.has(a.toLowerCase()))c.set(a.toLowerCase(),{expansion:r.expansion});}}catch{}return(tokens)=>{if(!c.size)return tokens;const seen=new Set(tokens.map(t=>t.toLowerCase())),ex=[];for(const t of tokens){const h=c.get(t.toLowerCase());if(!h)continue;for(const w of expTokens(h.expansion))if(!seen.has(w)){seen.add(w);ex.push(w);}}return[...tokens,...ex];};}
function buildMatch(text,expand){const u=Array.from(new Set(bias(expand(tokenize(text)),text.toLowerCase()))).slice(0,60);return u.length?u.map(t=>`"${t.replace(/"/g,'""')}"`).join(" OR "):'""';}
function vecToBlob(v){return Buffer.from(v.buffer,v.byteOffset,v.byteLength);}

const db = new Database(CORPUS,{readonly:true,fileMustExist:true});
db.pragma("cache_size=-20000"); sqliteVec.load(db);
const expand = mkExpand(db);
const isLeaf = db.prepare("SELECT 1 AS x FROM clauses WHERE id LIKE ? || '.%' LIMIT 1");
const getClause = db.prepare("SELECT id,title,parent_title FROM clauses WHERE id=?");
const rrf = db.prepare(`
  WITH fts_top AS (SELECT c.rowid rowid, ROW_NUMBER() OVER (ORDER BY bm25(clauses_fts)) rk FROM clauses_fts JOIN clauses c ON c.rowid=clauses_fts.rowid WHERE clauses_fts MATCH ? LIMIT ?),
  vec_top AS (SELECT rowid, ROW_NUMBER() OVER (ORDER BY distance) rk FROM clauses_vec WHERE embedding MATCH ? AND k=?),
  fused AS (SELECT rowid, SUM(1.0/(?+rk)) s FROM (SELECT rowid,rk FROM fts_top UNION ALL SELECT rowid,rk FROM vec_top) GROUP BY rowid)
  SELECT c.id, c.title FROM fused JOIN clauses c ON c.rowid=fused.rowid ORDER BY fused.s DESC LIMIT ?`);

const doc = JSON.parse(fs.readFileSync(QUERIES,"utf8"));
const queries = (doc.queries||[]).filter(q=>q.query&&q.expectedClauseId);

const tf = await import("@huggingface/transformers");
const extractor = await tf.pipeline("feature-extraction","Xenova/bge-small-en-v1.5",{dtype:"q8"});
const embed = async (t)=>{const o=await extractor(t,{pooling:"cls",normalize:true});return o.data instanceof Float32Array?o.data:new Float32Array(o.data);};

const out = [];
let miss=0, rl=0, top1=0;
for (const q of queries) {
  const exists = !!getClause.get(q.expectedClauseId);
  const leaf = exists ? !isLeaf.get(q.expectedClauseId) : false;
  const vec = await embed(q.query);
  let raw = rrf.all(buildMatch(q.query,expand), PER_SOURCE, vecToBlob(vec), PER_SOURCE, RRF_K, PER_SOURCE);
  raw = raw.filter(r=>!isTestSpec(r.id));               // demoted: test specs sink (here, drop for ranking view)
  const pool = raw.slice(0, POOL_N);
  const rank = pool.findIndex(r=>r.id===q.expectedClauseId)+1 || 0; // 0 = miss
  const mode = rank===1 ? "top1" : (rank>=2&&rank<=10) ? "ranked-low" : "recall-miss";
  if (mode==="recall-miss") miss++; else if (mode==="ranked-low") rl++; else top1++;
  out.push({ qid:q.qid, stratum:q.stratum, query:q.query, expectedClauseId:q.expectedClauseId,
    expectedTitle: exists ? getClause.get(q.expectedClauseId).title : null, exists, leaf, rank, mode,
    top10: pool.slice(0,10).map(r=>({id:r.id,title:r.title})) });
}
fs.mkdirSync(path.dirname(REPORT),{recursive:true});
fs.writeFileSync(REPORT, JSON.stringify(out,null,2));

console.log(`\nqid  stratum    rank mode         expected (exists/leaf)`);
for (const r of out) {
  console.log(`${String(r.qid).padStart(3)}  ${(r.stratum||"").padEnd(9)} ${String(r.rank||"·").padStart(4)} ${r.mode.padEnd(11)} ${r.expectedClauseId} ${r.exists?"":"❌MISSING "}${r.exists&&!r.leaf?"⚠NON-LEAF ":""}«${(r.expectedTitle||"?").slice(0,40)}»`);
}
console.log(`\nsummary: top1=${top1} ranked-low=${rl} recall-miss=${miss}  (n=${out.length})`);
console.log(`report → ${REPORT}`);
db.close();
