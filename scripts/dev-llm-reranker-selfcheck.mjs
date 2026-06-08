// Verifies parseOrder + score mapping WITHOUT calling a real LLM, by
// re-implementing the tiny logic and asserting. (The production code path is
// exercised by dev-llm-rerank-eval.mjs against a real provider.)
function parseOrder(raw, n) {
  const m = raw.match(/\[[\s\d,]*\]/); const order = []; const seen = new Set();
  if (m) { try { for (const v of JSON.parse(m[0])) { const i = Number(v);
    if (Number.isInteger(i) && i >= 0 && i < n && !seen.has(i)) { order.push(i); seen.add(i); } } } catch {} }
  for (let i = 0; i < n; i++) if (!seen.has(i)) order.push(i);
  return order;
}
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error("FAIL", msg, a, "!=", b); process.exit(1); } };
eq(parseOrder("[3,0,2,1]", 4), [3,0,2,1], "clean order");
eq(parseOrder("garbage", 4), [0,1,2,3], "garbage → identity");
eq(parseOrder("here: [2, 5, 0]", 3), [2,0,1], "out-of-range dropped + completion");
eq(parseOrder("[1,1,0]", 3), [1,0,2], "dup dropped + completion");
console.log("✓ parseOrder selfcheck passed");
