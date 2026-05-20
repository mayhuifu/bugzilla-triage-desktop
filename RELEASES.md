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

## v0.1.22 — Diag endpoint now reports file-existence and db-open errors

**Tagged:** —
**Published:** —

### Highlights

- **`/api/corpus/diag` now shows why `engineLoaded` is false** when `engineError` is null. Three new fields explain the most common cases:
  - `fileExists` — does `corpus.sqlite` exist on disk at the expected path?
  - `fileSizeBytes` — its size (0 = truncated, ~10–55 MB = healthy)
  - `dirExists` + `dirContents` — what's actually in the corpus directory (handy when the install renamed something)
  - `openError` — the exact error string when `new Database(...)` throws (e.g. SQLITE_NOTADB on a corrupt file, EBUSY on a lock)
  - `fileExistedOnLastOpen` — what the store believed at its last try
- **Reveals install-state bugs that v0.1.20's diag missed.** A user reported `engineLoaded: false, engineError: null` — meaning better-sqlite3 loaded fine, but the engine still returned no DB. v0.1.22's diag will say whether that's "file is missing at expected path" or "file exists but is unreadable", which determines the recovery path (re-download vs. re-install vcredist vs. unlock the file).

### Changes

- `lib/corpus/store.ts` — `getCorpusDb()` now captures the file-existence check and the db-open exception into module-level state. Three new exports: `corpusOpenError()`, `corpusFileExistedOnLastTry()`, `corpusLastTriedPath()`.
- `app/api/corpus/diag/route.ts` — extends the response with `fileExists`, `fileSizeBytes`, `fileMtime`, `dirExists`, `dirContents`, `openError`, `fileExistedOnLastOpen`.

### Upgrade notes

- Purely diagnostic — no behaviour change for working installs.
- After installing v0.1.22, hit `http://localhost:3000/api/corpus/diag` again and the new fields should narrow down whatever's wrong on a broken install in one shot.

---

## v0.1.21 — Default corpus URL → rel17-v3 (adds 38.304 / 38.133 / 36.304 / 36.133)

**Tagged:** —
**Published:** —

### Highlights

- **rel17-v3 is now the default corpus.** The companion repo published [rel17-v3](https://github.com/mayhuifu/bugzilla-triage-corpus/releases/tag/rel17-v3) — adds 38.304 (NR idle-mode RRC procedures), 38.133 (NR RRM requirements), 36.304 (LTE idle mode), and 36.133 (LTE RRM). Citations like `TS 38.304 §5.2.4.5` and `TS 38.133 §4.2` now resolve through to real leaf clauses with "View clause" buttons.
- **Corpus size jumped** from 5,667 → 12,930 leaf clauses, and download grew from ~26 MB to ~55 MB gzipped (~160 MB on disk). 38.133 alone added 3,722 clauses; 36.133 added 3,412. These are the largest cellular specs by clause count, but worth the size because they're cited heavily in idle-mode and RRM triage.
- **Existing rel17-v2 installs auto-upgrade.** If your `settings.json` still has the rel17-v2 default URL (i.e. you accepted the default and never edited it), `loadSettings()` rewrites it to v3 on next launch. The installed corpus file itself stays at v2 until you re-download — open Settings → Spec corpus → "Check for updates" → Install to get v3.

### Changes

- `lib/settings.ts` — `DEFAULT_CORPUS_MANIFEST_URL` switched to `…/rel17-v3/…`. v2 added to `LEGACY_DEFAULT_CORPUS_MANIFEST_URLS` set so existing v2-default installs migrate.
- `components/settings/CorpusSection.tsx` — corpus-blurb stats updated (12,930 / 17,490 / 36 specs / ~55 MB compressed).

### Upgrade notes

- New `.exe` / `.dmg` / `.AppImage` installs: corpus banner offers rel17-v3 (~55 MB).
- Returning v2 installs: URL rewrites silently. To upgrade the installed corpus file, click **"Check for updates"** in Settings → Spec corpus.
- Returning v1 installs (from before v0.1.16): auto-upgrade jumps v1 → v3 directly.
- Custom mirror URLs are untouched.

---

## v0.1.20 — Diagnose missing "View clause" buttons + "spec not in corpus" UI

**Tagged:** —
**Published:** —

### Highlights

- **Self-service diagnostic endpoint** at `/api/corpus/diag`. Returns engine state, schema columns, total clauses, and a live trace of `lookupClause()` against three reference citations (one expected-leaf, two expected-ancestor). Hit it once and the JSON tells us exactly where in the chain (engine load / schema mismatch / SQL miss / parser miss) the bug is.
- **"Spec not in corpus" UI** — when the AI cites a spec we never curated (e.g. `TS 38.304` or `TS 38.133`), the chip now reads `[not in corpus]` in amber instead of the generic `[ai paraphrase]` in gray. A small italic line under the citation says *"This spec isn't in the curated 3GPP corpus — model paraphrase only."* So users understand it's a coverage gap, not a broken lookup.
- **Three corpus-state caches removed.** `corpusHasV2Columns()` and `corpusHasSpec()` previously cached at module scope, which meant an in-process upgrade from v1 to v2 (or v2 to v3) read the OLD schema state forever. PRAGMA table_info is microsecond-cheap; just re-check.

### Changes

- `app/api/corpus/diag/route.ts` (new) — JSON dump of engine status, schema columns, total rows, sample SQL probes, and live `lookupClause` traces for known-leaf and known-non-leaf references. Surfaces exactly what's broken on a specific install. Use `Ctrl+Shift+I` → paste the URL `http://localhost:3000/api/corpus/diag` in the network tab and copy the response.
- `lib/corpus/retriever.ts` — dropped the `_v2ColsChecked` / `_v2ColsPresent` cache and the `_specPresenceCache` Map. Both rechecked per call; cheap.
- `lib/types.ts` — `SpecExcerpt.lookupReason: "spec_not_curated" | "clause_not_found" | "no_corpus"`. Optional, defaults missing.
- `lib/llm.ts` — `enrichExcerptsWithCorpus()` now sets `lookupReason` on every model-only excerpt by checking whether the cited spec is even in the corpus, via `corpusHasSpec()`. Also synthesises a bare excerpt for any `specReferences` entry that didn't come with a model summary, so the UI can always render the citation + reason.
- `components/triage/TriageChatPanel.tsx` — chip text + colour + tooltip now reflect `lookupReason`. Adds an italic explanatory line under model-only citations.

### Upgrade notes

- Purely additive on the API side (`/api/corpus/diag` is a new GET endpoint).
- The `[not in corpus]` chip only appears when the model cites a spec outside the curated set — for most cellular tickets you won't see it at all.
- The cache removal is a behaviour fix; nothing changes for users running a stable v2 corpus.

---

## v0.1.19 — Surface "engine unavailable" warning inside the triage panel

**Tagged:** —
**Published:** —

### Highlights

- **Engine-broken diagnostic now appears next to the "Use 3GPP Spec RAG" toggle** when the user enables RAG inside the triage panel. Previously v0.1.18 surfaced this state only on the home-page banner — users who jumped straight from the queue to a ticket and ran triage saw the RAG toggle, enabled it, and watched every citation come back as `[ai paraphrase]` with no "View clause" button, no idea why. The toggle stays visible (the corpus file IS installed) but a small amber notice underneath explains "Corpus engine unavailable — RAG queries will return no results" plus a link to the VC++ Redistributable.

### Changes

- `components/triage/TriageChatPanel.tsx` — fetches and tracks `engineError` from `/api/corpus/status` alongside `installed`. When RAG is enabled AND engineError is set, renders a compact inline warning under the toggle with the same VC++ Redistributable download link as the home-page banner.

### Upgrade notes

- Purely UI / diagnostic. If your `better-sqlite3` is loading fine, you'll never see this warning.
- If you're hitting "RAG enabled but only `[ai paraphrase]` citations": that's the engine-broken state. Install Visual C++ Redistributable (x64) from Microsoft and restart the app.

---

## v0.1.18 — Surface "installed but engine broken" state + Windows VC++ recovery hint

**Tagged:** —
**Published:** —

### Highlights

- **The Settings card and the AI Triage RAG toggle now correctly recognise a downloaded corpus** even when `better-sqlite3` fails to open it. v0.1.17 lazy-required the native binary so the download path stayed alive, but `/api/corpus/status` was still gating `installed` on the database opening successfully — so after the download finished, the UI silently reverted to the "Download corpus" state and the RAG toggle disappeared. This release decouples the two states.
- **Banner replaces the "Download" CTA with a clear, persistent diagnostic** when the corpus file is on disk but the engine can't load it. Shows the underlying error verbatim plus a one-click link to the Microsoft VC++ Redistributable installer (the fix in 95%+ of Windows cases).

### Why the engine fails on some Windows installs

`better-sqlite3` is a native Node addon — a `.node` file that depends on the Visual C++ runtime DLLs (`vcruntime140.dll` etc.). Fresh / minimal / disk-image-restored Windows installs often don't have those system DLLs, and `LoadLibrary` fails with errors like "The specified module could not be found." Installing the [Visual C++ Redistributable (x64)](https://aka.ms/vs/17/release/vc_redist.x64.exe) from Microsoft and restarting the app fixes it. Antivirus quarantining the `.node` file is the second-most-common cause.

### Changes

- `app/api/corpus/status/route.ts` — `installed` now reflects manifest presence only, not whether the engine successfully opened the DB. New `engineError: string | null` field exposes the underlying `better-sqlite3` load failure (sourced from v0.1.17's `corpusEngineError()`).
- `components/corpus/CorpusInstallBanner.tsx` — new "installed but engine broken" rendering branch with the actual error text, a link to the VC++ Redistributable installer, and a hint about Defender quarantine. Non-dismissible because triage retrieval can't work until the engine loads.

### Upgrade notes

- Purely additive. No settings or data migration.
- If your previous install of v0.1.17 showed an HTTP 500 then completed the download silently with no installed state: install v0.1.18 over it. The banner will now show the actual engine error and the fix link. Most users will: install the VC++ Redistributable, restart the app, see the corpus install as expected.

---

## v0.1.17 — Lazy-require better-sqlite3 so corpus download survives a broken native binary

**Tagged:** —
**Published:** —

### Highlights

- **The corpus-download endpoint no longer crashes when `better-sqlite3` can't load.** v0.1.10–v0.1.16's `lib/corpus/store.ts` had `import Database from "better-sqlite3"` as a top-level ES import. On a Windows install where the native `.node` binary fails to load — wrong arch prebuild, missing VC++ runtime DLL, AV quarantine, etc. — that top-level import throws **before any route handler in the corpus chain can run**. Next.js then returns an opaque 500 with no body (route module failed to load), and even v0.1.15's try/catch wrapper inside `POST /api/corpus/download` never gets a chance to catch it. The banner shows the literal `HTTP 500`.
- **Lazy-require fixes that:** `better-sqlite3` is now `require()`'d inside `getCorpusDb()` the first time the database is opened. If the native binary fails, `getCorpusDb()` records the error and returns `null` — exactly the same shape as "corpus not installed yet". Routes that don't need the DB (download, manifest fetch) keep working. Routes that do (lookup, retrieveContext) silently no-op and the triage UI falls back to model paraphrase.
- **Banner now surfaces response body text** even when the response isn't JSON. So if Next.js's default 500 HTML page is what comes back, the banner shows the first 300 chars of it instead of the bare status code — usable as diagnostic.
- **New `corpusEngineError()` helper** that `lib/corpus/store.ts` exposes for downstream UI surfacing of "native sqlite engine unavailable" as a distinct state from "corpus file missing".

### Why this matters now

The user reported HTTP 500 from the corpus download on a fresh Windows install of v0.1.14/15/16. The diagnostic wrapper from v0.1.15 didn't help — strongly suggesting the failure is at module-load, before the wrapper runs. v0.1.17 turns that failure mode into "download succeeds; retrieval gracefully degrades to model-only triage", which is a much better degradation curve than "feature completely unusable."

### Changes

- `lib/corpus/store.ts` — top-level `import Database from "better-sqlite3"` replaced with a `type`-only import + lazy `require` inside `loadBetterSqlite3()`. New `corpusEngineError()` exported. `getCorpusDb()` returns `null` when the engine couldn't be loaded.
- `components/corpus/CorpusInstallBanner.tsx` — error handler now reads response body as text, attempts JSON parse, falls back to first 300 chars of the raw body. The literal `HTTP 500` only appears when the response body is genuinely empty.

### Upgrade notes

- Purely defensive. If `better-sqlite3` loaded fine on your machine before, nothing changes — the lazy require resolves the same constructor and the DB opens the same way.
- If you were seeing `HTTP 500` before, reinstall v0.1.17. Either the download will now succeed (revealing whether better-sqlite3 was the underlying problem), or the banner will print a longer error message that tells us where to look next.

---

## v0.1.16 — Default corpus URL now points at rel17-v2 (with auto-upgrade for legacy installs)

**Tagged:** —
**Published:** —

### Highlights

- **rel17-v2 is now the default corpus.** The companion repo [bugzilla-triage-corpus](https://github.com/mayhuifu/bugzilla-triage-corpus) just published [rel17-v2](https://github.com/mayhuifu/bugzilla-triage-corpus/releases/tag/rel17-v2) — 5,667 leaf clauses + 9,920 structured tables + 1,092 figure refs + sqlite-vec dense vectors (bge-m3), schemaVersion=2 in the SQLite. The desktop's default manifest URL now points there, so first-launch installs of v0.1.16 will offer this corpus.
- **Existing installs auto-upgrade silently.** If a returning user's `settings.json` still has the previously-shipped rel17-v1 default URL (i.e. they accepted the default and never edited it), `loadSettings()` rewrites it to the rel17-v2 default on next launch. Users who customised the URL to a SharePoint mirror or other internal source are untouched.

### Changes

- `lib/settings.ts` — `DEFAULT_CORPUS_MANIFEST_URL` switched to `…/rel17-v2/…`. New `LEGACY_DEFAULT_CORPUS_MANIFEST_URLS` set lists previously-shipped defaults; if `loadSettings()` finds an exact match in there, it rewrites the value before returning. Migration is in-memory only — `saveSettings()` next persists the new URL.
- `components/settings/CorpusSection.tsx` — corpus-status blurb updated from "5,631 clauses · ~40 MB" to reflect v2's "5,667 leaf clauses + 9,920 tables · ~80 MB, ~26 MB compressed download".

### Upgrade notes

- New `.exe` / `.dmg` / `.AppImage` installs: corpus banner offers rel17-v2 (~26 MB gzipped).
- Existing installs with the rel17-v1 default still saved: the URL rewrites silently, but the *installed* corpus is still v1 until you re-download — open Settings → Spec corpus → click **Check for updates** (or use the banner if it reappears) → install v2.
- Installs with a customised manifest URL (internal mirror): no change. To opt into v2 manually, edit the Manifest URL field in Settings to the rel17-v2 manifest URL on your mirror.

---

## v0.1.15 — Surface the real corpus-download error instead of an opaque HTTP 500

**Tagged:** —
**Published:** —

### Highlights

- **POST /api/corpus/download now returns a readable error message on any unexpected failure.** v0.1.14's banner UI showed `HTTP 500` when the download route threw an unhandled exception (settings read, manifest validation, fs operations, …), giving the user nothing to act on. This release wraps the entire handler in a top-level try/catch and returns `{ error: "download init failed: <name>: <message> [<code>]" }` so the banner can display the actual reason.
- The corpus itself is reachable — `rel17-v1` manifest + artifact return 200 OK from GitHub Releases. Whatever was throwing on the user's Windows machine is now visible.

### Changes

- `app/api/corpus/download/route.ts` — wrapped the POST handler in a top-level try/catch that captures Error name + message + code (when present) and returns it as JSON. Also defensively wrapped the post-download `saveSettings()` call so a settings-write failure can't mask a successful corpus install (the manifest sidecar already records the version).

### Upgrade notes

- Purely diagnostic. If the download was already working for you, nothing changes.
- When upgrading from v0.1.14 with a previously-failed download: clear `localStorage["corpusBannerDismissed"]` in the Electron DevTools console if you want the banner to re-show (or just open Settings → Spec corpus → Download).

---

## v0.1.14 — First-launch banner to install the optional 3GPP corpus

**Tagged:** —
**Published:** —

### Highlights

- **Corpus is now discoverable on first launch.** New users installing the released `.exe` / `.dmg` / `.AppImage` previously had no nudge to download the optional 3GPP RAG corpus — the only way in was Settings → Spec corpus, which most never opened. They'd run AI triage on the BM25-less fallback path forever without realising they were missing the corpus-backed real-spec-text feature. v0.1.14 surfaces a one-time banner on the home page (Triage Queue) with a single **Download corpus** CTA. Dismissible if the user really doesn't want it; auto-hides once installed; shows live progress while downloading.
- **Same install pipeline, different entry point.** The banner reuses the existing `/api/corpus/download` endpoint and respects the configured `corpusManifestUrl` (so China-blocked-GitHub users still get their SharePoint mirror once they've set it under Settings). No NSIS / installer scripting needed — the corpus stays a runtime download, which keeps the installer small and works the same on every OS.

### Why this matters

Without the corpus, AI triage falls back to the model's training-data paraphrase of spec sections. With the corpus, triage cites *real* clause text from Rel-17 NR + LTE with proper §-anchored references. The lift is significant on protocol-heavy tickets (RACH, BWP switching, RRC reconfiguration, RF testing). The corpus is ~10 MB gzipped → ~40 MB on disk; one-time download.

### Changes

- `components/corpus/CorpusInstallBanner.tsx` (new) — top-of-page banner that polls `/api/corpus/status`, shows a CTA when the corpus is missing and not dismissed, switches to a progress bar while downloading, and hides itself once installed. Dismissal is persisted via `localStorage["corpusBannerDismissed"]` (clear it to re-show the banner).
- `app/page.tsx` — mounts the banner above the Triage Queue header.

### Upgrade notes

- Purely additive. Users with the corpus already installed will never see the banner. Users who dismissed it via "Maybe later" can still install via Settings → Spec corpus.
- For users on a GitHub-blocked network: open Settings → Spec corpus → set the Manifest URL to your SharePoint mirror's manifest.json *before* clicking the banner's Download button — the banner uses whatever's configured at click time.

---

## v0.1.13 — Restore "View clause" button when model cites a non-leaf section

**Tagged:** —
**Published:** —

### Highlights

- **"View clause" button reappears for section-level citations.** Models tend to cite at section granularity (e.g. `TS 38.331 §5.3.5`), but the corpus only stores leaf clauses (`5.3.5.1`, `5.3.5.2`, …). v0.1.10–v0.1.12 silently dropped those references because `lookupClause` returns null on a non-leaf id — and no `clauseId` means the Initial Classification bubble doesn't show the "View clause" button at all. v0.1.13 adds an ancestor-prefix fallback: if the exact id misses, look for the lexically smallest leaf under the cited prefix and return that. The button comes back; the drawer shows real content.
- **Ancestor-match hint in the drawer.** When the lookup falls back to a descendant, the drawer shows an amber notice: *"The cited reference TS 38.331 §5.3.5 is a parent section. Showing its first leaf clause TS 38.331 §5.3.5.1."* — so users can see exactly which clause is being displayed and why it differs from the cited reference.

### Changes

- `lib/corpus/retriever.ts` — `lookupClause()` gains a `LIKE '<id>.%'` ancestor fallback after the exact PK miss, ordered by id, limit 1. Returns the leaf with new `matchedAs: "exact" | "ancestor"` and `requestedClauseId` fields so the UI knows whether to show the hint.
- `components/triage/SpecDrawer.tsx` — renders the ancestor-match hint banner above the clause body when `matchedAs === "ancestor"`.

### Upgrade notes

- Purely additive on the corpus side (no schema bump). The fields `matchedAs` / `requestedClauseId` default to `"exact"` / `undefined` for direct hits so no caller breaks.
- The fallback is conservative: it only triggers when there's no exact match, and only walks one level of LIKE matching. Cross-spec / cross-section guesses are not attempted.

---

## v0.1.12 — CI release fix: route artifacts straight to the Release, skip workflow-artifact upload on tag pushes

**Tagged:** —
**Published:** —

### Highlights

- **Re-ship of v0.1.10 + v0.1.11 with the CI release flow fixed.** v0.1.10 and v0.1.11 builds both succeeded on every matrix runner (Windows / macOS / Linux), but the `actions/upload-artifact` step that runs *before* the `softprops/action-gh-release` step failed with `Failed to CreateArtifact: Artifact storage quota has been hit`. Because that step had `if-no-files-found: error`, it failed the whole job, which prevented `Attach to release` from running — so neither version produced an installer on the GitHub Release page.
- Same code as v0.1.11. If v0.1.11 had shipped successfully it would be functionally identical; v0.1.12 just brings the artifacts.

### Changes

- `.github/workflows/release.yml` — reordered + conditionalised the post-build steps:
  - `Attach to release` now runs **first** on tag pushes (`if: always() && startsWith(...)`) so the .exe/.dmg/.AppImage land on the GitHub Release via the REST API, which doesn't touch the Actions artifact-storage quota.
  - `Upload installer` is now scoped to `workflow_dispatch` only — workflow-artifact storage is only useful for dry-runs, never for tag releases (where the Release page is the canonical source).

### Upgrade notes

- Purely build-pipeline. No code or behaviour change vs v0.1.11 from a user perspective.
- Future tag pushes are no longer blocked by Actions storage quota for this repo. If quota is restored later, dispatch-mode dry-runs will start producing workflow artifacts again automatically.

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
