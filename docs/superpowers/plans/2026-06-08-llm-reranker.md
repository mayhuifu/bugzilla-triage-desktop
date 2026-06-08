# LLM Reranker (reuse AI Triage provider) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a listwise LLM reranker to the `/spec` search UI that reuses the configured AI Triage provider — opt-in via an explicit button, with hybrid-vs-LLM delta comparison — replacing the held 266 MB cross-encoder with zero bundled model.

**Architecture:** A lean provider-agnostic `runLlmText()` in `lib/llm.ts` (mirrors the 4-way triage dispatch: Anthropic/OpenAI SDK, claude-cli, codex-cli) → an `LlmReranker` implementing the existing `CorpusReranker` hook → a `fuseOrders()` RRF helper + a per-call `rerank:"llm"` option threaded `retrieveByText → hybridRetrieve` (search-only; triage untouched) → search route `?rerank=llm` → `/spec` ranking toggle + delta badges. LLM-optional (hybrid is the floor), default OFF, eval-gated.

**Tech Stack:** Next.js (server routes + client `/spec` page), TypeScript, `@anthropic-ai/sdk`, `openai` SDK, child_process spawns for the CLIs, existing better-sqlite3 hybrid retriever.

---

## Standing constraints
- **Branch:** `llm-reranker` (desktop), off `main`. All commits here.
- **Commits:** the maintainer's rule is "commit/push only when asked"; approving this plan sanctions the per-task commits below (local; pushing is a separate explicit step). End every commit with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **No test runner** exists in this repo; "tests" are dev self-check scripts + typecheck (`npx tsc --noEmit`) + manual `/spec` verification. The LLM eval harness is user-run (the agent sandbox can't reach `api.anthropic.com`).
- **Never touch the triage path** (`runTriage*`, `retrieveContextAsync`, the triage routes). The reranker is strictly additive.

## File structure

| File | Action | Responsibility |
|---|---|---|
| `lib/llm.ts` | **Modify** | Add `runLlmText(system,user,opts)` (generic 4-provider text call) + `hasConfiguredLlmProvider(s)` helper. Triage code unchanged. |
| `lib/corpus/reranker-llm.ts` | **Create** | `LlmReranker implements CorpusReranker` — listwise prompt → `runLlmText` → parse order → scores. Never throws. |
| `lib/corpus/retriever.ts` | **Modify** | `fuseOrders()` RRF helper; thread `rerank?:"llm"` through `retrieveByText`→`hybridRetrieve`; attach `hybridRank`. |
| `app/api/corpus/search/route.ts` | **Modify** | Accept `?rerank=llm` (gated on provider); return `rerankAvailable`, `ranking`, per-result `hybridRank`. |
| `components/spec/SpecResultCard.tsx` | **Modify** | Render the `▲/▼/•/★` rank-delta badge. |
| `app/spec/page.tsx` | **Modify** | `ranking` state + toggle buttons (Hybrid / ✨ AI rerank, disabled w/ tooltip) + pass `rerank` to fetch + compute delta. |
| `scripts/dev-llm-rerank-eval.mjs` | **Create** | User-run eval: hybrid vs LLM-rerank on the 73-query set, per `mode` stratum. |

---

## Task 1: `runLlmText` + provider-configured helper (`lib/llm.ts`)

**Files:** Modify `lib/llm.ts`

- [ ] **Step 1: Add `hasConfiguredLlmProvider` near the other settings consumers** (after the `runTriage` export, ~line 760, or anywhere top-level). It mirrors the validation logic at `lib/settings.ts:323-332`:

```typescript
/** True when the configured provider can actually be called: CLI providers
 *  use a subscription (no key), SDK providers need a key (and a baseURL for
 *  openai-compatible). Used to gate the opt-in LLM reranker — never to gate
 *  plain hybrid search. */
export function hasConfiguredLlmProvider(s = loadSettings()): boolean {
  switch (s.llmProvider) {
    case "claude-cli":
    case "codex-cli":
      return true; // subscription via local binary
    case "openai-compatible":
      return !!s.anthropicApiKey && !!s.llmBaseUrl;
    case "anthropic":
    default:
      return !!s.anthropicApiKey;
  }
}
```

- [ ] **Step 2: Add `runLlmText` — the lean generic call.** Place it AFTER `spawnAndCapture` (~line 1151) so it can reuse `spawnAndCapture`/`spawnAndDrain`/`stripJsonFence` already defined in the file. It re-implements ONLY the provider dispatch + model resolution from `runTriage` (lines 693-711, 839/963/1063/1274) — no vision/PDF/schema/parse/enrich.

```typescript
/** Generic, provider-agnostic one-shot LLM call: system + user prompt → raw
 *  text. A LEAN sibling of the runTriage<Provider> functions (deliberately NOT
 *  a refactor of them — the shipped triage path must stay untouched). Used by
 *  the corpus LLM reranker. Throws on hard provider failure; the caller
 *  (LlmReranker) catches and degrades to hybrid. No images/PDFs/JSON-schema.
 *
 *  `opts.timeoutMs` bounds the call so a slow provider can't freeze search. */
export async function runLlmText(
  system: string,
  user: string,
  opts: { model?: string; maxTokens?: number; timeoutMs?: number } = {},
): Promise<string> {
  const s = loadSettings();
  const maxTokens = opts.maxTokens ?? 1024;
  const timeoutMs = opts.timeoutMs ?? 12_000;

  // Model resolution mirrors runTriage's CLI-specific normalization.
  let model = opts.model || s.defaultModel || DEFAULT_MODEL;
  if (s.llmProvider === "claude-cli" && !/^(opus|sonnet|haiku|claude-)/i.test(model)) {
    model = "opus";
  }
  if (s.llmProvider === "codex-cli") {
    model = /^(gpt-|o\d|chatgpt-|codex)/i.test(model) ? model.toLowerCase() : "";
  }

  const withTimeout = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, rej) =>
        setTimeout(() => rej(new Error(`runLlmText timed out after ${timeoutMs}ms`)), timeoutMs)),
    ]);

  // ── Anthropic SDK ──
  if (s.llmProvider === "anthropic") {
    const client = new Anthropic({ apiKey: s.anthropicApiKey });
    const resp = await withTimeout(client.messages.create({
      model, max_tokens: maxTokens, system,
      messages: [{ role: "user", content: user }],
    }));
    const block = resp.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    return (block?.text ?? "").trim();
  }

  // ── OpenAI-compatible SDK ──
  if (s.llmProvider === "openai-compatible") {
    const client = new OpenAI({ apiKey: s.anthropicApiKey, baseURL: s.llmBaseUrl });
    const resp = await withTimeout(client.chat.completions.create({
      model, max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }));
    return (resp.choices[0]?.message?.content ?? "").trim();
  }

  // ── claude-cli ──  (envelope { result })
  if (s.llmProvider === "claude-cli") {
    const stdout = await withTimeout(spawnAndCapture("claude", [
      "-p", "--output-format", "json", "--model", model,
      "--system-prompt", system, user,
    ]));
    let envelope: { result?: string };
    try { envelope = JSON.parse(stdout); }
    catch { throw new Error(`claude CLI returned non-JSON: ${stdout.slice(0, 200)}`); }
    return (envelope.result ?? "").trim();
  }

  // ── codex-cli ──  (no --system-prompt; combine; read -o output file)
  if (s.llmProvider === "codex-cli") {
    const combined = `${system}\n\n---\n\n${user}`;
    const tmpRoot = path.join(os.tmpdir(), `corpus-rerank-${randomBytes(6).toString("hex")}`);
    await fs.mkdir(tmpRoot, { recursive: true });
    try {
      const outputPath = path.join(tmpRoot, "result.txt");
      const cliArgs = ["exec", "--skip-git-repo-check", "--sandbox", "read-only",
        "--ephemeral", "--cd", tmpRoot, "-o", outputPath];
      if (model) cliArgs.push("-m", model);
      cliArgs.push("-");
      await withTimeout(spawnAndDrain("codex", cliArgs, combined));
      return (await fs.readFile(outputPath, "utf8")).trim();
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  }

  throw new Error(`runLlmText: unsupported provider ${s.llmProvider}`);
}
```

NOTE for implementer: confirm `DEFAULT_MODEL`, `Anthropic`, `OpenAI`, `spawnAndCapture`, `spawnAndDrain`, `stripJsonFence`, `os`, `path`, `fs`, `randomBytes` are all already imported/defined in `lib/llm.ts` (they are — used by `runTriage*`). If `spawnAndDrain`'s signature differs from `(cmd, args, stdin)`, match its actual signature (read lines ~1276+).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "lib/llm.ts" || echo "✓ llm.ts clean"`
Expected: `✓ llm.ts clean`

- [ ] **Step 4: Commit**

```bash
git add lib/llm.ts
git commit -m "$(cat <<'EOF'
feat(llm): add provider-agnostic runLlmText + hasConfiguredLlmProvider

Lean text->text call mirroring the 4-way triage provider dispatch
(anthropic/openai SDK, claude-cli, codex-cli), timeout-bounded. Parallel
to runTriage* — shipped triage path untouched. Backs the LLM reranker.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `LlmReranker` (`lib/corpus/reranker-llm.ts`)

**Files:** Create `lib/corpus/reranker-llm.ts`

- [ ] **Step 1: Write the reranker.** Implements the existing `CorpusReranker` interface (`lib/corpus/reranker.ts`: `{ modelId, rerank(query, passages): Promise<number[]> }`, higher score = more relevant, must not throw, returns `[]` for empty input).

```typescript
// lib/corpus/reranker-llm.ts — listwise LLM reranker (next-gen RAG).
// Reranks the hybrid candidate pool by asking the user's CONFIGURED AI Triage
// provider to order the clauses by relevance. No bundled model. LLM-optional:
// only constructed when a provider is configured; ANY failure returns the
// input order (identity scores) so the retriever silently keeps hybrid.
import "server-only";
import type { CorpusReranker } from "./reranker";
import { runLlmText, hasConfiguredLlmProvider } from "@/lib/llm";
import { loadSettings } from "@/lib/settings";

const SYSTEM = "You are a precise information-retrieval relevance ranker for 3GPP " +
  "telecom specifications. You only output JSON.";

/** Build the listwise prompt. Passages are pre-formatted (title-prefixed). */
function buildPrompt(query: string, passages: string[]): string {
  const list = passages.map((p, i) => `[${i}] ${p}`).join("\n\n");
  return `Query:\n${query}\n\nCandidate clauses:\n${list}\n\n` +
    `Rank ALL ${passages.length} candidates from most to least relevant to the query. ` +
    `Output ONLY a JSON array of the candidate indices (0-based) in ranked order, ` +
    `best first, every index exactly once. Example: [3,0,7,1].`;
}

/** Parse the model's index array defensively: keep valid in-range unique
 *  indices in stated order, then append any missing indices in original order
 *  so the result is always a full permutation. */
function parseOrder(raw: string, n: number): number[] {
  const m = raw.match(/\[[\s\d,]*\]/);
  const order: number[] = [];
  const seen = new Set<number>();
  if (m) {
    try {
      for (const v of JSON.parse(m[0]) as unknown[]) {
        const i = Number(v);
        if (Number.isInteger(i) && i >= 0 && i < n && !seen.has(i)) { order.push(i); seen.add(i); }
      }
    } catch { /* fall through to identity */ }
  }
  for (let i = 0; i < n; i++) if (!seen.has(i)) order.push(i);
  return order;
}

export class LlmReranker implements CorpusReranker {
  readonly modelId: string;
  constructor() {
    const s = loadSettings();
    this.modelId = `llm:${s.llmProvider}:${s.defaultModel || "default"}`;
  }
  async rerank(query: string, passages: string[]): Promise<number[]> {
    const n = passages.length;
    if (n === 0) return [];
    const identity = passages.map((_, i) => n - i); // input order preserved
    if (!hasConfiguredLlmProvider()) return identity;
    try {
      const raw = await runLlmText(SYSTEM, buildPrompt(query, passages), {
        maxTokens: 512, timeoutMs: 12_000,
      });
      const order = parseOrder(raw, n);              // permutation, best-first
      // Map ranked position → descending score so the caller's sort reproduces
      // `order` (position 0 → highest score n).
      const scores = new Array<number>(n);
      order.forEach((idx, pos) => { scores[idx] = n - pos; });
      return scores;
    } catch {
      return identity; // never throw — degrade to hybrid order
    }
  }
}

/** Lazily build a singleton (settings read once per process is fine — the
 *  retriever reads settings per request via hasConfiguredLlmProvider anyway). */
let _llmReranker: LlmReranker | null = null;
export function getLlmReranker(): LlmReranker {
  return (_llmReranker ??= new LlmReranker());
}
```

- [ ] **Step 2: Self-check with a stubbed LLM.** Create `scripts/dev-llm-reranker-selfcheck.mjs`:

```javascript
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
```

Run: `node scripts/dev-llm-reranker-selfcheck.mjs`
Expected: `✓ parseOrder selfcheck passed`

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "reranker-llm.ts" || echo "✓ reranker-llm.ts clean"`
Expected: `✓ reranker-llm.ts clean`

- [ ] **Step 4: Commit**

```bash
git add lib/corpus/reranker-llm.ts scripts/dev-llm-reranker-selfcheck.mjs
git commit -m "$(cat <<'EOF'
feat(corpus): LlmReranker — listwise LLM reranker via runLlmText

Implements the CorpusReranker hook by asking the configured provider to
order the candidate pool; defensive permutation parse; never throws
(degrades to input order). Self-check covers parse edge cases.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `fuseOrders` + thread `rerank:"llm"` through the retriever

**Files:** Modify `lib/corpus/retriever.ts`

Context: `hybridRetrieve(matchExpr, queryText, limit, rerankQuery?)` already fetches a wide pool and (when a reranker is registered) reorders it. Today's path uses the dormant cross-encoder in `replace` mode. We add `fuse` + a per-call LLM option WITHOUT disturbing that.

- [ ] **Step 1: Add the `fuseOrders` helper** (top-level, near `rerankPassage`):

```typescript
/** Reciprocal-rank fusion of two orderings of the same id set. Returns ids
 *  sorted by fused score desc. `1/(k+rank)` for each list; ids appearing in
 *  both get both terms. This protects top-1 (a strong hybrid #1 can't be
 *  fully overridden by a noisy reranker) — the combo that won the eval. */
function fuseOrders(hybridIds: string[], rerankedIds: string[], k = 60): string[] {
  const rank = (ids: string[]) => new Map(ids.map((id, i) => [id, i + 1]));
  const hr = rank(hybridIds), rr = rank(rerankedIds);
  const all = new Set([...hybridIds, ...rerankedIds]);
  const score = (id: string) =>
    (hr.has(id) ? 1 / (k + hr.get(id)!) : 0) + (rr.has(id) ? 1 / (k + rr.get(id)!) : 0);
  return [...all].sort((a, b) => score(b) - score(a));
}
```

- [ ] **Step 2: Add `hybridRank` to the `RetrievedClause` type** (find the interface, add field):

```typescript
  /** 1-based position in the pre-rerank hybrid order. Present only on
   *  results from an LLM-reranked search; the UI shows the rank delta. */
  hybridRank?: number;
```

- [ ] **Step 3: Thread the `rerank` option.** Change `retrieveByText`'s options + `hybridRetrieve`'s params to carry `rerank?: "llm"`. In `hybridRetrieve`, AFTER the RRF pool is built (the `candidates` array, hybrid order) and BEFORE/instead of the existing cross-encoder block, add the LLM branch:

```typescript
  // candidates: RetrievedClause[] in hybrid (RRF) order, already demoted+sliced
  // to the pool. (Existing code above this point — unchanged.)
  if (rerank === "llm" && hasConfiguredLlmProvider()) {
    const pool = candidates.slice(0, RERANK_CANDIDATE_K);
    const hybridIds = pool.map(c => c.clauseId);
    const hybridRankById = new Map(hybridIds.map((id, i) => [id, i + 1]));
    try {
      const scores = await getLlmReranker().rerank(
        rerankQuery || queryText,
        pool.map(rerankPassage),
      );
      const rerankedIds = pool
        .map((c, i) => ({ id: c.clauseId, s: scores[i] ?? -Infinity }))
        .sort((a, b) => b.s - a.s)
        .map(x => x.id);
      const fusedIds = fuseOrders(hybridIds, rerankedIds);
      const byId = new Map(pool.map(c => [c.clauseId, c]));
      const fused = fusedIds.map(id => byId.get(id)!).filter(Boolean).map(c => ({
        ...c,
        retrieverPath: "hybrid-rrf+llm-rerank" as const,
        hybridRank: hybridRankById.get(c.clauseId),
      }));
      return fused.slice(0, limit);
    } catch (err) {
      console.warn("[corpus] LLM rerank failed; returning hybrid:", err);
      // fall through to the plain hybrid return below
    }
  }
```

Add imports at top: `import { getLlmReranker } from "./reranker-llm";` and `import { hasConfiguredLlmProvider } from "@/lib/llm";`. Add `"hybrid-rrf+llm-rerank"` to the `retrieverPath` union on `RetrievedClause`.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "retriever.ts|reranker-llm.ts|llm.ts" || echo "✓ clean"`
Expected: `✓ clean`

- [ ] **Step 5: Commit**

```bash
git add lib/corpus/retriever.ts
git commit -m "$(cat <<'EOF'
feat(corpus): fuseOrders + per-call rerank:"llm" (search-only)

RRF fusion of hybrid+LLM orders (protects top-1); LLM rerank fires only
when rerank:"llm" is passed AND a provider is configured. Triage callers
never pass it. Attaches hybridRank for the UI delta. Graceful hybrid
fallback on any failure.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Search route — `?rerank=llm` + `rerankAvailable` + `hybridRank`

**Files:** Modify `app/api/corpus/search/route.ts`

- [ ] **Step 1: Import the provider check** at the top:

```typescript
import { hasConfiguredLlmProvider } from "@/lib/llm";
```

- [ ] **Step 2: In `GET`, read the param + gate it, pass to retrieval, surface `hybridRank` + flags.** Replace the free-text retrieval block:

```typescript
  // Free-text retrieval. ?rerank=llm opts into LLM reranking, but ONLY when a
  // provider is configured — otherwise we silently stay hybrid (offline floor).
  const rerankAvailable = hasConfiguredLlmProvider();
  const wantLlm = url.searchParams.get("rerank") === "llm" && rerankAvailable;
  const results = await retrieveByText(q, { limit, ...(wantLlm ? { rerank: "llm" as const } : {}) });
  const mediaFlags = getClauseMediaFlags(results.map(r => r.clauseId));
  return NextResponse.json({
    query: q,
    kind: "text",
    corpusInstalled,
    retrieverPath: results[0]?.retrieverPath ?? path,
    hybridActive: isHybrid(results[0]?.retrieverPath ?? path),
    rerankAvailable,
    ranking: wantLlm ? "llm" : "hybrid",
    results: results.map((r, i) => ({
      ...toCard(r, mediaFlags.get(r.clauseId)),
      hybridRank: r.hybridRank,
      rank: i + 1,
    })),
  });
```

- [ ] **Step 3: Extend `isHybrid` to recognize the new path** so the badge still shows hybrid-active:

```typescript
function isHybrid(p: string): boolean {
  return p === "hybrid-rrf" || p === "hybrid-rrf+rerank" || p === "hybrid-rrf+llm-rerank";
}
```

- [ ] **Step 4: Also return `rerankAvailable` in the empty-query and citation responses** (so the page knows on first load): add `rerankAvailable: hasConfiguredLlmProvider()` to those two `NextResponse.json` objects.

- [ ] **Step 5: Typecheck + manual probe**

```bash
npx tsc --noEmit 2>&1 | grep -E "search/route.ts" || echo "✓ route clean"
```
Expected: `✓ route clean`. (Live probe happens in Task 7 manual verification.)

- [ ] **Step 6: Commit**

```bash
git add app/api/corpus/search/route.ts
git commit -m "$(cat <<'EOF'
feat(corpus): search route accepts ?rerank=llm (provider-gated)

Returns rerankAvailable + ranking + per-result hybridRank/rank so the /spec
UI can offer the toggle and render hybrid-vs-LLM deltas. Falls back to
hybrid when no provider.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `/spec` UI — ranking toggle + delta badges

**Files:** Modify `app/spec/page.tsx`, `components/spec/SpecResultCard.tsx`

- [ ] **Step 1: `SpecResultCard` — add the delta badge.** Add `hybridRank?: number` and `rank?: number` to the `SpecSearchResult` type, and render a badge when `ranking==="llm"` and `hybridRank` is set. Add a `ranking?: "hybrid" | "llm"` prop to the card (or compute the delta in the parent and pass `delta`). Badge logic:

```tsx
// delta = hybridRank - currentRank (positive = moved up under LLM)
function RankDelta({ hybridRank, rank }: { hybridRank?: number; rank: number }) {
  if (hybridRank == null) return <span title="new to top results" className="text-amber-400 text-xs">★ new</span>;
  const d = hybridRank - rank;
  if (d === 0) return <span className="text-slate-500 text-xs" title="unchanged vs hybrid">•</span>;
  return d > 0
    ? <span className="text-emerald-400 text-xs" title={`up ${d} vs hybrid (#${hybridRank})`}>▲{d}</span>
    : <span className="text-rose-400 text-xs" title={`down ${-d} vs hybrid (#${hybridRank})`}>▼{-d}</span>;
}
```
Render `<RankDelta hybridRank={result.hybridRank} rank={result.rank!} />` in the card header when the parent indicates `ranking==="llm"`. "★ new" = the clause entered the top-N under reranking from outside the hybrid top-N (its `hybridRank` is undefined because it wasn't in the returned hybrid window).

- [ ] **Step 2: `app/spec/page.tsx` — state + toggle + fetch param.** Add:

```tsx
const [ranking, setRanking] = useState<"hybrid" | "llm">("hybrid");
const [rerankAvailable, setRerankAvailable] = useState(false);
```
In the search fetch (line ~84), include the param and read the flags:

```tsx
const rerankQS = ranking === "llm" ? "&rerank=llm" : "";
const res = await fetch(`/api/corpus/search?q=${encodeURIComponent(trimmed)}&limit=25${rerankQS}`);
// …after const data = await res.json():
setRerankAvailable(!!data.rerankAvailable);
// if the server downgraded (no provider) reflect it:
if (ranking === "llm" && data.ranking !== "llm") setRanking("hybrid");
```
Add the toggle control next to `RetrieverBadge` (line ~164):

```tsx
<div className="inline-flex rounded-md border border-slate-700 overflow-hidden text-xs">
  <button
    onClick={() => setRanking("hybrid")}
    className={ranking === "hybrid" ? "bg-slate-700 px-2 py-1" : "px-2 py-1 text-slate-400"}
  >Hybrid</button>
  <button
    onClick={() => rerankAvailable && setRanking("llm")}
    disabled={!rerankAvailable}
    title={rerankAvailable ? "Rerank the results with your configured AI provider" : "Configure an AI provider in Settings to enable AI rerank"}
    className={ranking === "llm" ? "bg-indigo-700 px-2 py-1" : `px-2 py-1 text-slate-400 ${!rerankAvailable ? "opacity-40 cursor-not-allowed" : ""}`}
  >✨ AI rerank</button>
</div>
```
Re-run the search when `ranking` changes (so toggling re-ranks the current query): add `ranking` to the search effect's deps, or call the search function in the button handlers with the current `lastSearched`/`query`.

- [ ] **Step 3: Probe `rerankAvailable` on mount** so the button state is correct before the first search. The page already learns `corpusInstalled` from the first response; also set `rerankAvailable` from any search response (Step 2 does this). For the pre-search state, fire one empty probe in the existing mount effect:

```tsx
useEffect(() => { fetch("/api/corpus/search?q=").then(r => r.json())
  .then(d => { setCorpusInstalled(!!d.corpusInstalled); setRerankAvailable(!!d.rerankAvailable); })
  .catch(() => {}); }, []);
```
(Only add if no equivalent mount probe exists; otherwise extend the existing one.)

- [ ] **Step 4: Pass `ranking` down to the results list / cards** so `RankDelta` only renders in LLM mode. Thread `ranking` to the component that maps `results` to `SpecResultCard`.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "spec/page.tsx|SpecResultCard.tsx" || echo "✓ ui clean"`
Expected: `✓ ui clean`

- [ ] **Step 6: Commit**

```bash
git add app/spec/page.tsx components/spec/SpecResultCard.tsx
git commit -m "$(cat <<'EOF'
feat(spec): Hybrid / AI-rerank toggle + rank-delta comparison badges

Explicit ranking control (AI rerank disabled w/ tooltip when no provider);
each result shows ▲/▼/•/★ movement vs the hybrid baseline so users compare
hybrid vs LLM ranking directly. Default Hybrid.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: User-run eval harness (`scripts/dev-llm-rerank-eval.mjs`)

**Files:** Create `scripts/dev-llm-rerank-eval.mjs`

- [ ] **Step 1: Write the harness.** Reuses the corpus + hybrid RRF plumbing from `dev-rerank-eval.mjs`, but the rerank step calls the configured provider via a minimal listwise prompt (the harness can't import the server-only `lib/llm.ts`, so it shells the same CLIs / hits the SDKs directly based on env — keep it simple: support `RERANK_PROVIDER=anthropic|claude-cli`). Metrics match `dev-rerank-eval.mjs` (MRR@10/R@1/R@10, per `mode` via `GROUP_BY=mode`, rescued/demoted).

```javascript
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
  // anthropic via curl (avoids SDK import here)
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
```

- [ ] **Step 2: Smoke the harness shape** (no provider needed for a parse check):

Run: `node -e "import('/Users/huifu/bugzilla-triage-desktop/scripts/dev-llm-rerank-eval.mjs')" 2>&1 | head -3` — expect it to start (it will fail later without a provider/corpus, which is fine for a syntax check). If it throws a SyntaxError, fix it.

- [ ] **Step 3: Commit**

```bash
git add scripts/dev-llm-rerank-eval.mjs
git commit -m "$(cat <<'EOF'
feat(eval): dev-llm-rerank-eval — LLM rerank vs hybrid on the 73-query set

Same metrics/strata as the cross-encoder gate, run locally with a provider
(claude-cli or anthropic). Used to decide whether to flip the AI-rerank
default on.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Manual verification + status surface

**Files:** none (verification) — optional small edit to the `RetrieverBadge` note.

- [ ] **Step 1: Typecheck whole project**

Run: `npx tsc --noEmit` → Expected: no new errors.

- [ ] **Step 2: Run the dev server + verify the 4 states** (user, on their machine):
```bash
npm run dev   # then open http://localhost:3000/spec
```
Verify:
1. **No provider configured** (Settings → blank key, provider anthropic): AI-rerank button **disabled** with tooltip; searches are hybrid.
2. **Provider configured** (e.g. claude-cli): click ✨ AI rerank → results reorder, each card shows **▲/▼/•/★** vs hybrid; badge reads "Hybrid + LLM rerank" / `ranking:"llm"`.
3. **Toggle back to Hybrid** → original hybrid order, no deltas.
4. **Forced failure** (bad key / kill network): AI rerank → returns hybrid results, no error toast.

- [ ] **Step 3: (optional) RetrieverBadge note** — extend the `reranked` branch (page.tsx ~218) to also describe `hybrid-rrf+llm-rerank` ("Hybrid retrieval reranked by your AI provider"). Keep it cosmetic.

- [ ] **Step 4: Run the eval (user, local) to gate the default**
```bash
RERANK_PROVIDER=claude-cli node scripts/dev-llm-rerank-eval.mjs
```
Record the Δ vs hybrid (and compare to the held cross-encoder's +5.5 R@1). The AI-rerank default stays OFF regardless; flipping it on is a separate, evidence-based follow-up.

- [ ] **Step 5: Commit any cosmetic edits + final**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(spec): LLM-rerank badge copy + verification notes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review (against the spec)

**Spec coverage:**
- runLlmText (4 providers) → Task 1. ✓
- LlmReranker (CorpusReranker, never-throws, defensive parse) → Task 2. ✓
- fuseOrders + rerank:"llm" threading, search-only, hybridRank → Task 3. ✓
- Search route ?rerank=llm + rerankAvailable + hybridRank → Task 4. ✓
- /spec toggle (disabled w/ tooltip) + delta badges (compare) → Task 5. ✓
- dev-llm-rerank-eval.mjs (user-run, same metrics) → Task 6. ✓
- LLM-optional guarantee (provider AND toggle; hybrid floor) → Tasks 3/4/5 gating; verified Task 7 state 1. ✓
- Triage untouched → no task edits runTriage*/retrieveContextAsync; verified by not modifying them. ✓
- Error handling (timeout, fallback, never breaks search) → Task 1 withTimeout, Task 2 try/catch, Task 3 fall-through, Task 4 always-200, verified Task 7 state 4. ✓
- Default OFF / eval-gated → Task 5 `ranking` defaults "hybrid"; Task 6/7 eval. ✓
- CLI risk resolved: all 4 providers covered (Task 1) — no SDK-only fallback needed. ✓

**Placeholder scan:** All steps carry real code. The only "read and match" notes (Task 1 imports check, Task 5 thread-`ranking`-to-card) are integration verifications against existing files the implementer has open, not deferred logic.

**Type/name consistency:** `runLlmText(system,user,opts)`, `hasConfiguredLlmProvider`, `LlmReranker`/`getLlmReranker`, `fuseOrders(hybridIds,rerankedIds,k)`, `rerank:"llm"`, `retrieverPath:"hybrid-rrf+llm-rerank"`, `hybridRank`, `rerankAvailable`, `ranking` — consistent across Tasks 1-6. `RERANK_CANDIDATE_K`/`RRF_K` reuse existing retriever constants.
