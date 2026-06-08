// scripts/dev-llm-rerank-eval.mjs — measure LLM-rerank lift vs hybrid on the
// 73-query set, the same bar the cross-encoder was gated on. RUN LOCALLY with
// a provider (the agent sandbox can't reach the API).
//   ANTHROPIC_API_KEY=… RERANK_PROVIDER=anthropic RERANK_MODEL=claude-sonnet-4-5 node scripts/dev-llm-rerank-eval.mjs
//   RERANK_PROVIDER=claude-cli node scripts/dev-llm-rerank-eval.mjs       # uses your Claude Code subscription
import { createRequire } from "node:module";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const BASE = "/Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049";
const CORPUS = process.env.CORPUS || `${BASE}/out/corpus.sqlite`;
const QUERIES = process.env.QUERIES || `${BASE}/scripts/eval-queries.json`;
const PROVIDER = process.env.RERANK_PROVIDER || "claude-cli";
const MODEL = process.env.RERANK_MODEL || (PROVIDER === "claude-cli" ? "sonnet" : "claude-sonnet-4-5");
const RRF_K = 60, PER_SOURCE = 80, POOL_N = 50, CAND_K = 30, TOP = 10;

const db = new Database(CORPUS, { readonly: true }); db.pragma("cache_size=-20000"); sqliteVec.load(db);
const STOP = new Set(["the","and","for","that","this","with","from","when","have","been","are","was","were","will","into","but","not"]);
const toks = t => Array.from(new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu," ").split(/\s+/).filter(x=>x.length>=3&&x.length<=32&&!STOP.has(x))));
const match = t => { const u=toks(t).slice(0,60); return u.length?u.map(x=>`"${x.replace(/"/g,'""')}"`).join(" OR "):'""'; };
const vecToBlob = v => Buffer.from(v.buffer,v.byteOffset,v.byteLength);
const rrf = db.prepare(`WITH fts_top AS (SELECT c.rowid rowid,ROW_NUMBER() OVER(ORDER BY bm25(clauses_fts)) rk FROM clauses_fts JOIN clauses c ON c.rowid=clauses_fts.rowid WHERE clauses_fts MATCH ? LIMIT ?),vec_top AS (SELECT rowid,ROW_NUMBER() OVER(ORDER BY distance) rk FROM clauses_vec WHERE embedding MATCH ? AND k=?),fused AS (SELECT rowid,SUM(1.0/(?+rk)) s FROM (SELECT rowid,rk FROM fts_top UNION ALL SELECT rowid,rk FROM vec_top) GROUP BY rowid) SELECT c.id,c.title,c.parent_title,c.text,fused.s FROM fused JOIN clauses c ON c.rowid=fused.rowid ORDER BY fused.s DESC LIMIT ?`);
const tf = await import("@huggingface/transformers");
const ex = await tf.pipeline("feature-extraction","Xenova/bge-small-en-v1.5",{dtype:"q8"});
const embed = async t => { const o = await ex(t,{pooling:"cls",normalize:true}); return o.data instanceof Float32Array?o.data:new Float32Array(o.data); };

function callLlm(system, user) {
  if (PROVIDER === "claude-cli") {
    const r = spawnSync("claude", ["-p","--output-format","json","--model",MODEL,"--system-prompt",system,user], { encoding:"utf8", maxBuffer:1e8 });
    if (r.status !== 0) throw new Error(r.stderr||"claude failed");
    return (JSON.parse(r.stdout).result||"").trim();
  }
  const body = JSON.stringify({ model:MODEL, max_tokens:512, system, messages:[{role:"user",content:user}] });
  const r = spawnSync("curl",["-sS","https://api.anthropic.com/v1/messages","-H",`x-api-key: ${process.env.ANTHROPIC_API_KEY}`,"-H","anthropic-version: 2023-06-01","-H","content-type: application/json","-d",body],{encoding:"utf8",maxBuffer:1e8});
  const j = JSON.parse(r.stdout); return (j.content?.[0]?.text||"").trim();
}
function parseOrder(raw,n){const m=raw.match(/\[[\s\d,]*\]/);const o=[],seen=new Set();if(m){try{for(const v of JSON.parse(m[0])){const i=Number(v);if(Number.isInteger(i)&&i>=0&&i<n&&!seen.has(i)){o.push(i);seen.add(i);}}}catch{}}for(let i=0;i<n;i++)if(!seen.has(i))o.push(i);return o;}
function fuse(h,r,k=RRF_K){const rk=a=>new Map(a.map((id,i)=>[id,i+1]));const H=rk(h),R=rk(r);const all=new Set([...h,...r]);const sc=id=>(H.has(id)?1/(k+H.get(id)):0)+(R.has(id)?1/(k+R.get(id)):0);return[...all].sort((a,b)=>sc(b)-sc(a));}

const doc = JSON.parse(fs.readFileSync(QUERIES,"utf8")); const qs = doc.queries.filter(q=>q.query&&q.expectedClauseId);
const acc = q => new Set(q.acceptableClauseIds?.length?q.acceptableClauseIds:[q.expectedClauseId]);
const rankIn=(ids,a)=>{for(let i=0;i<ids.length;i++)if(a.has(ids[i]))return i+1;return Infinity;};
const sm=rs=>({mrr:rs.reduce((s,r)=>s+(r<=10?1/r:0),0)/rs.length,r1:rs.filter(r=>r===1).length/rs.length,r10:rs.filter(r=>r<=10).length/rs.length});
const per={}; const H=[],L=[];
for(const q of qs){
  const v=await embed(q.query);
  const pool=rrf.all(match(q.query),PER_SOURCE,vecToBlob(v),PER_SOURCE,RRF_K,POOL_N).slice(0,CAND_K);
  const hybridIds=pool.map(r=>r.id);
  const passages=pool.map(r=>`${r.parent_title?r.parent_title+" — ":""}${r.title}. ${(r.text||"").slice(0,1000)}`);
  let order; try { order=parseOrder(callLlm("You are a precise IR relevance ranker. Output only JSON.",`Query:\n${q.query}\n\nCandidates:\n${passages.map((p,i)=>`[${i}] ${p}`).join("\n\n")}\n\nRank ALL ${passages.length} by relevance, output ONLY a JSON array of indices best-first.`),pool.length);} catch(e){order=pool.map((_,i)=>i);}
  const rerankedIds=order.map(i=>hybridIds[i]);
  const fused=fuse(hybridIds,rerankedIds);
  const a=acc(q); H.push(rankIn(hybridIds,a)); L.push(rankIn(fused,a));
  const st=q.mode||q.stratum||"?"; (per[st]??={h:[],l:[]}); per[st].h.push(rankIn(hybridIds,a)); per[st].l.push(rankIn(fused,a));
  process.stdout.write(`\r${H.length}/${qs.length}`);
}
const h=sm(H),l=sm(L),pct=x=>(x*100).toFixed(1).padStart(5),d=(a,b)=>((b-a)*100>=0?"+":"")+((b-a)*100).toFixed(1);
console.log(`\n\n══ LLM rerank (${PROVIDER}:${MODEL}) vs hybrid — n=${qs.length} ══`);
console.log(`            MRR@10  R@1   R@10`);
console.log(`hybrid     ${pct(h.mrr)} ${pct(h.r1)} ${pct(h.r10)}`);
console.log(`+llm       ${pct(l.mrr)} ${pct(l.r1)} ${pct(l.r10)}`);
console.log(`Δ          ${d(h.mrr,l.mrr)}  ${d(h.r1,l.r1)}  ${d(h.r10,l.r10)} (pp)`);
console.log(`\nper-mode MRR@10 / R@1 (hybrid→llm):`);
for(const st of Object.keys(per).sort()){const a=sm(per[st].h),b=sm(per[st].l);console.log(`  ${st.padEnd(11)} MRR ${pct(a.mrr)}→${pct(b.mrr)} (${d(a.mrr,b.mrr)})  R@1 ${pct(a.r1)}→${pct(b.r1)} (${d(a.r1,b.r1)})`);}
db.close();
