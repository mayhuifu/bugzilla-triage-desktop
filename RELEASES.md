# Release notes

Single source of truth for what shipped in each tagged release. New entries land **here first**, then get pasted into the GitHub Release page when the artifacts are published. Most recent at the top.

> **Workflow** (do this every time a new tag is cut):
>
> 1. Bump `package.json#version` to the next tag (e.g. `0.1.8`).
> 2. **Write the entry below** for that version using the template at the bottom of this file. Commit it together with the version bump.
> 3. Tag the commit (`git tag -a vX.Y.Z -m "…"; git push origin vX.Y.Z`). CI auto-builds installers into a draft release.
> 4. After CI finishes, copy the section from this file into the GitHub Release's body (`gh release edit vX.Y.Z --notes-file <(awk '...')` if you want to script it, or paste manually) and flip `--draft=false` to publish.
> 5. Keep this file as the canonical changelog — it's what users browsing the repo read.

---

## v0.1.11 — Package sqlite-vec native binaries in the installer

**Tagged:** —
**Published:** —

### Highlights

- **Windows / Mac / Linux installers now ship the `vec0` native binary.** v0.1.10 added the `sqlite-vec` dependency but `electron-builder.json` didn't list it under `extraResources`, so the installer's standalone Next.js bundle was missing both the JS loader and the per-platform `.dll`/`.dylib`/`.so`. Runtime fallback in `store.ts` (added in v0.1.10) covers this gracefully — the retriever just stays on BM25-only — but to unlock hybrid retrieval later we need the binary actually packaged. v0.1.11 fixes the packaging.
- No code changes vs v0.1.10. If you already updated to v0.1.10, this release is only meaningful when an embedder gets registered (future PR); update at your convenience.

### Changes

- `electron-builder.json` — added `node_modules/sqlite-vec` to the top-level `extraResources` (JS loader, all platforms). Added platform-specific `extraResources` under each of `win` / `mac` / `linux` for the matching `sqlite-vec-<plat>-<arch>` binary subpackage. The store.ts cwd-based path resolution from v0.1.10 lines up with the in-installer copy location (`<resources>/app/.next/standalone/node_modules/sqlite-vec-<plat>-<arch>/vec0.<ext>`).

### Upgrade notes

- Purely additive. Existing v0.1.10 behaviour is unchanged.
- Cross-OS builds (e.g. `dist:win` on a Mac) will fail to find `node_modules/sqlite-vec-windows-x64` because npm's `optionalDependencies` only install the host-matching subpackage. Build each installer on its target OS, or use the `release.yml` CI workflow which runs `dist:<os>` on the matching matrix runner.

---

## v0.1.10 — Corpus v2 support + Initial Classification UX (short summary, real tables in drawer)

**Tagged:** —
**Published:** —

### Highlights

- **Corpus v2 support.** Reads the upcoming `rel17-v2` corpus that ships sqlite-vec dense vectors, a wider FTS5 index (parent_title + path), an acronyms table, and `meta.schemaVersion=2`. Stays fully backward-compatible with installed v1 corpora — schemaVersion is detected at open time and the retriever picks `bm25-v1` / `bm25-v2` / `hybrid-rrf` accordingly. Full hybrid retrieval lights up automatically once a query-time embedder is registered via `setCorpusEmbedder()` (bundling the embedder ONNX is a separate follow-up).
- **Initial Classification panel: short summary in main view, full clause in the drawer.** Previously the editable textarea under each corpus-matched spec reference was pre-filled with the full clause text — often hundreds of lines. Now it shows a ~280-char auto-condensed summary (sentence-aware). The full corpus text remains a click away via **View clause** → SpecDrawer. Edits in the main textarea write to `summary`, which is what the comment header builder now prefers — so what you see is what gets posted to Bugzilla.
- **Real HTML tables in the drawer.** Clauses with tables used to render as walls of `| pipe | rows |` in a `<pre>`. Now the drawer reads the v2 corpus's structured `tables_json` and renders proper `<table>` elements (with header-row heuristic, striped rows, horizontal scroll for wide tables). v1 corpora fall back to a heuristic pipe-row parser. Figure references are listed below the clause body when present.
- **Acronym-expanded queries.** On v2 corpora, the retriever expands common 3GPP acronyms (PUSCH ↔ Physical Uplink Control Channel, BWP ↔ Bandwidth Part, etc.) from the corpus's `acronyms` table before BM25 — so a bug text using only the abbreviation still finds clauses that spell it out.
- **Sister-repo release**: corresponds to [bugzilla-triage-corpus PR #1](https://github.com/mayhuifu/bugzilla-triage-corpus/pull/1) shipping the v2 corpus build pipeline. This desktop release lands first so the v2 corpus has a consumer ready when it publishes.

### Changes

- `package.json` — added `sqlite-vec` dependency (optional native loader; falls back gracefully on hosts where the per-platform binary isn't available).
- `lib/corpus/manifest.ts` — accept `schemaVersion ∈ {1, 2}` (previously hard-coded `1`).
- `lib/corpus/store.ts` — best-effort load of the `sqlite-vec` extension on db open. Detects whether the open corpus actually carries a `clauses_vec` table. New `corpusHasVectors()` helper. Webpack-safe binary resolution via a `process.cwd()/node_modules/sqlite-vec-<plat>-<arch>/vec0.<ext>` fallback so Next.js bundling can't break the load.
- `lib/corpus/acronyms.ts` (new) — lazily reads the acronyms table; `expandAcronyms()` appends expansion-tokens to a tokenised bug-text query.
- `lib/corpus/embedder.ts` (new) — pluggable `CorpusEmbedder` interface plus `setCorpusEmbedder()` for late-binding a runtime embedder. Stub returns null in this release; bundling the actual ONNX is a follow-up.
- `lib/corpus/retriever.ts` — `decidePath()` picks `bm25-v1` (v1 corpus) / `bm25-v2` (v2 corpus, BM25 over wider FTS5 + acronym expansion) / `hybrid-rrf` (v2 corpus + embedder registered + model match). New `retrieveContextAsync()` exposes the hybrid path; sync `retrieveContext()` kept for back-compat and always uses BM25. `lookupClause()` now surfaces `tables[]` + `figures[]` from `tables_json` / `figures_json` on v2 corpora.
- `app/api/tickets/[id]/triage/route.ts` + `…/followup/route.ts` — switch to `await retrieveContextAsync(ticket)` so hybrid activates the moment an embedder lands.
- `lib/llm.ts` — `enrichExcerptsWithCorpus()` auto-condenses corpus `realText` into a short `summary` (~280 chars, sentence-aware) when the model didn't supply one. `pickHeaderBody()` inverted to prefer the user-editable `summary` over the full `realText`. `realText` stays intact in the excerpt as the source of truth for the drawer.
- `components/triage/TriageChatPanel.tsx` — Initial Classification textarea binds to `summary` (always); edits target `summary` not `realText`; reduced from 4 rows to 2.
- `components/triage/SpecDrawer.tsx` — renders v2 structured tables as real `<table>`s (header heuristic, striped rows, horizontal-scroll overflow). Pipe-row leftovers stripped from the flattened text when structured tables are present. v1 fallback parses pipe-rows heuristically. Figure references listed under the body.

### Upgrade notes

- Purely additive — existing v1 corpora work unchanged on the v1 retrieval path. No settings.json schema bump.
- The new `sqlite-vec` dep is optional at runtime: if its per-platform binary isn't installed the retriever logs `[corpus] sqlite-vec not loaded` once and continues with BM25-only. `electron-builder` packages whatever native binaries are in `node_modules` at build time.
- The full ~25-point hybrid-retrieval precision lift (per Telco-DPR / TelcoAI benchmarks) is dormant in this release because no query-time embedder is bundled yet — only the wider FTS5 index + acronym expansion contribute to v2's precision over v1. Bundling the embedder is a separate follow-up PR.

---

## v0.1.9 — v0.1.8 features + CI fix (better-sqlite3 native rebuild)

**Tagged:** 2026-05-17  
**Published:** —

### Highlights

Same user-facing changes as v0.1.8 (see below — RAG opt-in toggle, retrieval transparency, prompt fix that restored model citations, neutral branding). v0.1.8's CI failed to produce installers because `@electron/rebuild` tried to compile `better-sqlite3@12.x` from source against Electron 42's V8 13 headers — the macOS native rebuild fails with `'Value' declared here` errors (V8 dropped the zero-arg `External::Value()` signature in favor of `Value(tag)`). The same failure quietly broke v0.1.6 and v0.1.7's CI too — none of those tags ever shipped artifacts.

### CI / build changes

- `electron-builder.json` — added `"npmRebuild": false`. The prebuilt N-API binary fetched by `npm install` is ABI-stable across Node and Electron runtimes; we don't need to (and can't, on current Electron) rebuild from source. Local builds and CI both rely on this prebuild now.
- `electron-builder.json` — Mac target arch list is `["arm64"]` only (was `["arm64", "x64"]`). With `npmRebuild: false`, electron-builder packages whatever native binary is in `node_modules` — that's the host arch's prebuild, which is `darwin-arm64` on the CI's `macos-latest` runner. **Intel Mac installer is dropped for v0.1.9** — re-fetch instructions for an x64 binary will return in a later release.
- `.github/workflows/release.yml` — `strategy.fail-fast: false`. Previously one platform's failure cancelled the others; now Windows / Linux / Mac builds are independent, so a single-platform regression doesn't block the rest.

### Upgrade notes

- **Intel Mac users:** v0.1.8 was unbuildable, so the last working Intel Mac installer is **v0.1.4**. v0.1.9 ships arm64 only; Intel support will return after we figure out cross-arch native-binary fetching in CI.
- v0.1.8 tag remains in git history but its CI never produced installers — treat it as a broken intermediate.

### Everything below this section was originally drafted for v0.1.8 — same behavior changes apply

## v0.1.8 — Triage UX polish + RAG opt-in & transparency

**Tagged:** 2026-05-17  
**Published:** Never — CI failure (better-sqlite3 native rebuild against Electron 42 V8 13 headers). Features rolled forward into v0.1.9.

### Highlights

- **3GPP RAG is now opt-in.** The corpus retrieval that v0.1.6 introduced defaulted to ON when the corpus was installed, which surfaced tangential clauses on tickets that weren't cellular-protocol bugs. Now there's an explicit **"Use 3GPP Spec RAG"** checkbox under the **Run AI Triage** button — defaults **off** on first use, persists per-user via `localStorage`.
- **Retrieval transparency.** When RAG runs, a new **"Corpus retrieval"** bubble appears in the chat right after the classification, listing every candidate clause BM25 surfaced with a green `cited` chip or gray `skip` chip based on whether the model picked it. Makes it obvious why the model cited (or didn't cite) specific clauses.
- **Fixed: empty `specReferences` when RAG was on.** v0.1.6/v0.1.7's prompt framed retrieved clauses as "CANDIDATE references — cite ONLY when genuinely relevant", which DeepSeek interpreted as a hard whitelist. On non-cellular-PHY tickets where BM25 returned tangential clauses, the model would emit `specReferences: []` — losing the training-data citations it would have produced without RAG. New prompt explicitly invites citing training-data clauses too, with a worked example.
- **Tighter retrieval.** Top-K reduced from 6 to 4 candidates, so even when RAG is enabled the model sees fewer false-positive citations.
- **Neutral branding.** The small label above each AI bubble used to read **`CLAUDE · AI TRIAGE`** — now reads **`AI TRIAGE`**. The bulk-triage subtitle's "your Claude Code subscription" was also stale (the app supports DeepSeek / OpenAI-compatible now) — updated to "your configured LLM provider".

### Changes

- `lib/llm.ts` — prompt section that injects retrieved clauses rewritten. Old framing was "cite ONLY when relevant"; new framing is "treat as ADDITIONAL evidence alongside training-data knowledge — feel free to cite OTHER clauses when retrieved set doesn't fit". Plus `TriageOptions.enrichWithCorpus?: boolean` (default true) gates `enrichExcerptsWithCorpus()` in both provider paths.
- `lib/corpus/retriever.ts` — `TOP_K`: 6 → 4 (precision over recall).
- `app/api/tickets/[id]/triage/route.ts` + `/followup` — read `?rag=` query param (server default still ON when absent so curl users keep v0.1.7 behavior). Response gains `ragEnabled` + `retrievedClauses: [{citation, title, parentTitle}]` (titles only, no full text) for UI transparency.
- `components/triage/TriageChatPanel.tsx` — new `useRag` state + checkbox under Run AI Triage. Persisted to `localStorage["bugzilla-triage-use-rag"]`, defaults off. New `retrieval-info` chat turn rendered after `ai-classification` when RAG was enabled — shows candidate clauses with `cited`/`skip` chips and a subtitle summarizing what the model picked.
- `components/triage/ChatBubble.tsx` — author label `"Claude · AI Triage"` → `"AI Triage"`.
- `app/bulk-triage/page.tsx` — subtitle says "via your configured LLM provider" instead of "via your Claude Code subscription".
- `RELEASES.md` (new file) — canonical changelog at repo root with backfilled entries for v0.1.1–v0.1.7 and a template at the bottom for future releases.
- `CLAUDE.md` — added "Release notes" subsection pointing at RELEASES.md and stating the rule: notes land there before the tag is cut, in the same commit as the version bump.

### Upgrade notes

- Existing users who had previously toggled the RAG checkbox during v0.1.7 testing will keep their cached value (`localStorage["bugzilla-triage-use-rag"]`). Users on a fresh install or who never clicked the toggle will see it default to **off**.
- API contract: when no `?rag=` is passed, the server still enables RAG (preserves v0.1.7 default). The UI explicitly sends `?rag=0` when the toggle is off.
- This is the **first release with `RELEASES.md`** as the canonical changelog. All future releases append their entry there before the tag is cut.

---

## v0.1.7 — 3GPP RAG UI: SpecDrawer + Settings corpus section

**Tagged:** 2026-05-17 (commit `7a2d9d5`)  
**Published:** Pending (CI run `25981322792` produced the draft release; notes hadn't been written)

### Highlights

Adds the user-facing layer for the M2 backend. v0.1.6 made RAG work end-to-end, but corpus management was API-only and there was no way to view a full clause without copy-pasting the citation into a separate browser tab.

- **Settings → 3GPP spec corpus.** A new card between AI Triage and Appearance. Shows install state + version chip + clause count + size; offers **Download** / **Check for updates** with live progress polling. The **Manifest URL is editable** so China-blocked-GitHub users can paste an internal SharePoint mirror URL and trigger a download against it before saving.
- **SpecDrawer overlay.** Right-side slide-in panel opened from any spec reference in the triage panel. Lazily fetches the full clause via `GET /api/corpus/lookup`; renders citation + parent breadcrumb + preformatted clause text. Buttons: Copy to clipboard, Open spec on 3GPP.org. Escape/backdrop-click close; focus-trapped.
- **Per-clause source tags.** Each spec reference in the "Initial classification" bubble now wears a `[corpus]` / `[corpus+model]` / `[ai paraphrase]` badge so the engineer knows at a glance whether they're reading real spec text or a model summary.

### Changes

- New `components/triage/SpecDrawer.tsx` — overlay + fetch + a11y (escape, focus trap, body-scroll lock).
- New `components/settings/CorpusSection.tsx` — status + download + progress bar + URL override.
- `components/triage/TriageChatPanel.tsx` — mounts SpecDrawer at panel root; per-clause source tag + View clause button in `ai-classification` turn; editable textarea now prefers `realText` when corpus matched.
- `app/settings/page.tsx` — corpus manifest URL form state, mounts `<CorpusSection />`.
- `README.md` / `CLAUDE.md` — corpus dependency documented, China mirror guidance.

### Upgrade notes

- No schema or data changes from v0.1.6. UI-only.

---

## v0.1.6 — 3GPP RAG: real spec text in AI triage

**Tagged:** 2026-05-17 (commit `f937323`)  
**Published:** Pending (CI run `25981122247` produced the draft release; notes hadn't been written)

### Highlights

Replaces the model's training-data paraphrase of cited 3GPP clauses with the actual clause text from a Release-17 NR + LTE corpus. The corpus is a single FTS5 SQLite file (~40 MB uncompressed, ~10 MB gzipped) downloaded to the per-user data directory on user opt-in. Source-of-truth pipeline lives in the [bugzilla-triage-corpus](https://github.com/mayhuifu/bugzilla-triage-corpus) repo (also published `rel17-v1` for the first time).

- **Pre-triage retrieval.** BM25 top-K over the local corpus, injected into the model's prompt as candidate references.
- **Post-triage enrichment.** Every clause the model emits is looked up in the corpus; matches attach `realText` + `title` + `parentTitle` + `source` to the `SpecExcerpt` for the CLASSIFICATION header to render.
- **Configurable manifest URL.** Defaults to GitHub Releases, but settable to any internal mirror (SharePoint / Confluence / S3) for users behind GitHub-blocked networks (mainland China). The manifest's `artifact.url` is followed transitively so a single override redirects everything.

Also folds in the never-tagged "v0.1.5 candidate" work that had been accumulating on main:

- **Version badge** (`v0.1.x`) in the top-left banner of every page.
- **Light-mode polish** — accent text colors and dark-only backgrounds now invert correctly via CSS-variable indirection on Tailwind palettes.
- **CLASSIFICATION header** at the top of every AI-authored Bugzilla comment, built server-side from confidence + domain + specReferences + specExcerpts.

### Changes

- New `lib/corpus/{store,manifest,downloader,retriever}.ts` — lazy SQLite singleton, atomic-rename downloader with sha256 verify, BM25 search + tolerant-regex clause lookup.
- New routes: `GET /api/corpus/status`, `POST /api/corpus/download`, `GET /api/corpus/lookup`.
- `lib/types.ts` — `SpecExcerpt` gains optional `clauseId` / `title` / `parentTitle` / `realText` / `source` (all backwards-compatible).
- `lib/settings.ts` — new `corpusManifestUrl` / `corpusVersion` / `corpusAutoUpdate` fields.
- `lib/llm.ts` — `runTriage` threads `opts.retrievedClauses` into `buildUserPrompt`; both provider paths call `enrichExcerptsWithCorpus()` before `withClassificationPrepended()`. Bug fixes from smoke testing: FTS5 query uses explicit `OR` (default is AND), tokens strip dots before MATCH.
- `app/api/tickets/[id]/triage/route.ts` + `/followup` — call `retrieveContext(ticket)` before `bridgeTriage`.
- `next.config.mjs` — `serverExternalPackages: ["better-sqlite3"]`.
- `electron-builder.json` — `asarUnpack: ["**/*.node"]` plus explicit `extraResources` for `better-sqlite3` + `bindings` + `file-uri-to-path`.
- New dep: `better-sqlite3` (+ ~3 MB native binding per platform-arch).

### Upgrade notes

- The corpus is optional. App works exactly like v0.1.5 with no corpus installed (model paraphrase as the fallback).
- v0.1.5 was never tagged or published; its work is rolled into v0.1.6.
- China deployment: override `corpusManifestUrl` in Settings or via env-var `CORPUS_MANIFEST_URL` to point at your internal mirror.

---

## v0.1.4 — Dual-theme color system

**Tagged:** 2026-05-16  
**Published:** 2026-05-16 ([release page](https://github.com/mayhuifu/bugzilla-triage-desktop/releases/tag/v0.1.4))

### Highlights

Adds a **light theme** alongside the existing dark one. Default follows the OS appearance (`prefers-color-scheme`); switch any time from **Settings → Appearance** (System / Light / Dark).

System mode live-updates while the app is open if you toggle Light/Dark in System Settings.

### Changes

- New `components/theme/ThemeManager.tsx` and the inline `<head>` bootstrap script in `app/layout.tsx` for no-FOUC theme application on first paint.
- `lib/settings.ts` — new `themeMode: "system" | "light" | "dark"` field.
- `tailwind.config.ts` + `app/globals.css` — `slate.*` color scale is now backed by CSS variables; light-mode flips inverted values so existing `text-slate-100` etc. flips automatically without touching ~200 component sites.

### Upgrade notes

- Existing settings.json files auto-migrate (the new `themeMode` defaults to `"system"`).

---

## v0.1.3 — DeepSeek compatibility + neutral "AI Triage Bot" rename

**Tagged:** 2026-05-16  
**Published:** 2026-05-16

### Highlights

Bug-fix release that addresses two issues surfaced after v0.1.2 launched multi-provider LLM support:

1. **DeepSeek triage failed** with `400 "This response_format type is unavailable now"`. The OpenAI-compatible path was using `response_format: json_schema`, which only OpenAI itself supports. Switched to the universally-supported `json_object` mode with the schema injected into the system prompt; defensive parsing strips ```json fences if the model adds them. Now works on DeepSeek, Ollama, Together, OpenRouter, Azure, vLLM, and real OpenAI.
2. **`"Analyzed by Claude"`** was the prefix and `cf_label` written to every AI-authored Bugzilla comment — misleading once the app supported non-Anthropic providers. Renamed everywhere to **`"Analyzed by AI Triage Bot"`**. Recognizers in `TicketComments` and `TicketTable` match both the new and the legacy strings so historical tickets still render with the AI styling.

### Upgrade notes

- No data migration. Old `"Analyzed by Claude"` tickets keep their styling.

---

## v0.1.2 — Multi-provider LLM config + manual triage mode

**Tagged:** 2026-05-16  
**Published:** 2026-05-16

### Highlights

- **Multi-provider LLM.** Settings → AI triage now exposes a Provider dropdown (Anthropic / OpenAI-compatible), an API base URL field, and a free-text "Custom…" option in the model picker. Works with corporate proxies (LiteLLM, Azure OpenAI, internal Anthropic gateways), local runners (Ollama, LM Studio, vLLM), and aggregators (OpenRouter).
- **Manual triage mode.** The triage panel now offers a **Manual Triage** button alongside **Run AI Triage**. Manual mode lets engineers type the analysis themselves and post to Bugzilla without invoking any LLM. The `manual:true` submit flag skips the `"Analyzed by Claude:"` prefix and the `Analyzed by Claude` cf_label (only AI-authored comments carry those).

### Upgrade notes

- Closes a key gap: the app no longer **requires** an LLM API key to do useful work with tickets — viewing + manual commenting now works with just Bugzilla credentials.

---

## v0.1.1 — First usable release

**Tagged:** 2026-05-16  
**Published:** 2026-05-16

### Highlights

The first installer that actually launches. **v0.1.0 was withdrawn** because the installer was missing bundled `node_modules` (the standalone Next.js server couldn't find `next` at runtime and exited immediately on macOS Sequoia + Apple Silicon).

Standalone desktop app for browsing Bugzilla tickets and running AI-assisted triage. No Node, Python, `claude` CLI, or `bugzilla-mcp` install needed — download, install, fill in URL + API key, go.

### Changes

- `electron-builder.json` — split `extraResources` into two entries so `node_modules` survives the implicit `!node_modules` filter (the PR-7 fix).

### Upgrade notes

- Start here. Do not install v0.1.0.

---

# Template for new releases

Copy this section verbatim when starting a new entry, then fill in the blanks. Drop empty subsections.

```markdown
## vX.Y.Z — <one-line summary> (unreleased)

**Tagged:** —
**Published:** —

### Highlights

- <2-5 bullets describing what changed in user-visible terms>

### Changes

- <file or module>: <what changed>
- ...

### Upgrade notes

- <data migrations, breaking changes, env-var renames, settings.json schema bumps>
- <"none — purely additive" is a perfectly fine line>
```

After the tag is pushed and CI completes:

1. Update the **Tagged** and **Published** lines.
2. Run `gh release edit vX.Y.Z --notes-file <(sed -n '/^## vX.Y.Z/,/^---$/p' RELEASES.md | sed '$d')` (or just paste the section).
3. `gh release edit vX.Y.Z --draft=false`.
