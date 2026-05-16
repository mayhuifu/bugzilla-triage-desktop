# Bugzilla AI Triage — Desktop

A standalone Windows / macOS / Linux app for triaging Bugzilla tickets with optional AI assistance. Sister product to [bugzilla-triage-dashboard](https://github.com/mayhuifu/bugzilla-triage-dashboard) (the original Claude Code CLI version).

This build is targeted at **non-technical teammates**. No terminal, no Python, no `claude` CLI, no `bugzilla-mcp` clone. Download the installer, double-click, fill in your Bugzilla URL + API key on the settings page, and the dashboard works.

> Core workflow:
> **Install → Settings → Browse tickets** · *(optional)* **Settings → Anthropic key → Run AI triage**

---

## For end users — install and use

### 1. Download the installer

Grab the latest release from the **[Releases page](https://github.com/mayhuifu/bugzilla-triage-desktop/releases)**:

| OS | File | Notes |
|---|---|---|
| **Windows 10/11** (x64) | `Bugzilla-AI-Triage-Setup-<version>.exe` | NSIS installer, **no admin rights required** (installs under `%LOCALAPPDATA%`) |
| **macOS** (Apple Silicon) | `Bugzilla-AI-Triage-<version>-arm64.dmg` | M1/M2/M3 Macs |
| **macOS** (Intel) | `Bugzilla-AI-Triage-<version>-x64.dmg` | older Intel Macs |
| **Linux** (x64) | `Bugzilla AI Triage-<version>.AppImage` | `chmod +x` then double-click |

> ⚠️ The Windows `.exe` is currently **unsigned** — Win10/11 SmartScreen will show *"Windows protected your PC · Unknown publisher"*. Click **More info → Run anyway**. macOS Gatekeeper will say *"unidentified developer"*; right-click → Open → Open. Code signing will be configured in a future release.

### 2. First-run setup

Launch the app. You'll see a banner asking you to configure Bugzilla. Click the **gear icon** in the top-right or the **Open Settings** button.

Fill in:

- **Bugzilla URL** — the base URL of your Bugzilla instance (e.g. `https://bugzilla.example.com`)
- **Bugzilla API key** — find it in Bugzilla under *Preferences → API Keys → Generate a new API key*
- **Your login email** — must match the email on your Bugzilla account
- **Skip TLS verification** — turn on if your Bugzilla uses a self-signed cert (typical for internal instances)

Click **Test connection** — green means you're good. Then click **Save settings**. Back to the dashboard.

### 3. (Optional) Enable AI triage

By default, the AI panel on the ticket detail page is unavailable. To turn it on:

1. Get an Anthropic API key from [console.anthropic.com](https://console.anthropic.com).
2. Back to **Settings → AI triage (optional)**.
3. Paste the key, pick a model (`claude-opus-4-7` is the default), and save.

AI calls are billed against **your own Anthropic account** — your key, your spend. The app never sends your data to anyone but Bugzilla and Anthropic.

### Where your settings live

The app writes to a single per-user JSON file. **Nothing else** is stored anywhere on disk.

| OS | Path |
|---|---|
| Windows | `%APPDATA%\bugzilla-triage-desktop\settings.json` |
| macOS | `~/Library/Application Support/bugzilla-triage-desktop/settings.json` |
| Linux | `$XDG_CONFIG_HOME/bugzilla-triage-desktop/settings.json` (or `~/.config/...`) |

The file is owner-read-write only (`0600`). API keys are currently stored plaintext at this path — a follow-up release will move them into the OS keychain via Electron `safeStorage`.

---

## What it does

Once configured, the dashboard gives you:

- **Filter by product, component, "My Tickets"** — dropdowns sourced live from Bugzilla; default product is U300.
- **Click any status card** to filter the table to that bucket (Open Total / Blocker / Critical, Closed Total / Blocker / Critical).
- **7-day trends** with week-over-week deltas and a trajectory projection (*"Backlog growing · +N/wk"* or shrinking/flat). Click any trend card to see the tickets that contributed to that metric.
- **25 tickets per page**, *Load 25 more* button at the bottom.
- **Saved filters** — bookmark any product/component/bucket/search combination, recall in one click. Stored in the browser's localStorage inside the app.
- **Bulk AI triage** — select multiple rows, click *Bulk AI triage*, watch up to 3 tickets analyze in parallel.
- **Resizable detail layout** — drag the divider between ticket context and the AI panel; width persists.
- **Inline attachment thumbnails** — image attachments render directly in the ticket detail page with a click-to-expand lightbox.
- **Auto-refresh** on every filter change.

---

## For developers

### Quick start

```bash
git clone https://github.com/mayhuifu/bugzilla-triage-desktop.git
cd bugzilla-triage-desktop
npm install
npm run dev:electron
```

This starts:
- `next dev` on port 3000 (the dashboard's web server)
- Electron in a new window pointing at `localhost:3000` (gives you the desktop window experience)

You can also run the dashboard in a regular browser via `npm run dev` and visit `http://localhost:3000` — the Electron wrapper is just a window around it.

### Architecture

```
┌──────────────────────────────────────────┐
│  Electron main process (main.cjs)        │
│  ┌────────────────────────────────────┐  │
│  │  BrowserWindow (Chromium)          │──┼─→ http://localhost:3000
│  │  → Next.js dashboard pages         │  │
│  └────────────────────────────────────┘  │
│  ┌────────────────────────────────────┐  │
│  │  Next.js standalone server         │  │
│  │  (spawned via ELECTRON_RUN_AS_NODE │  │
│  │   in production — no system Node)  │  │
│  │  ┌──────────────────────────────┐  │  │
│  │  │ /api/{tickets,stats,…}       │──┼──┼─→ Bugzilla REST
│  │  │ /api/tickets/:id/triage      │──┼──┼─→ Anthropic API
│  │  │ /api/settings{,/test}        │──┼──┼─→ settings.json (0600)
│  │  └──────────────────────────────┘  │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

**Pure TypeScript end-to-end.** No Python, no `uv`, no `bugzilla-mcp` clone, no `claude` CLI:
- `lib/bugzilla.ts` — direct Bugzilla REST client via `node:https`
- `lib/llm.ts` — Anthropic SDK with `output_config.format` for schema-validated JSON triage output
- `lib/settings.ts` — read/write the per-user `settings.json`
- `electron/main.cjs` — desktop window + dev-vs-packaged routing

### File layout

```
bugzilla-triage-desktop/
├── electron/
│   └── main.cjs                # desktop wrapper: window, spawn-Next, single-instance lock
├── app/
│   ├── page.tsx                # dashboard (queue + status + trends + filters)
│   ├── settings/page.tsx       # /settings UI (Bugzilla + Anthropic creds)
│   ├── tickets/[id]/page.tsx   # ticket detail (resizable split)
│   ├── bulk-triage/page.tsx    # multi-ticket AI runner
│   └── api/
│       ├── tickets/…           # search, fetch, submit, attachments, triage
│       ├── products/, whoami/, stats/    # dashboard data
│       └── settings/, settings/test/     # config CRUD + connection probe
├── lib/
│   ├── bugzilla.ts             # Bugzilla REST client
│   ├── llm.ts                  # Anthropic SDK triage
│   ├── settings.ts             # per-user settings.json
│   ├── nl-search.ts            # natural-language search parser
│   ├── saved-filters.ts        # localStorage-backed filter store
│   └── types.ts                # all shared types
├── components/                 # React UI components
├── build/
│   └── icon.png                # placeholder app icon (replace with a brand mark)
├── electron-builder.json       # NSIS / DMG / AppImage packaging config
├── next.config.mjs             # output: "standalone" for installer packaging
└── .github/workflows/release.yml  # tag v* → builds .exe + .dmg + .AppImage
```

### Local installer build

You can produce installer artifacts on your dev machine for **the same OS you're on**. Cross-OS builds (Mac → Win `.exe`) need Wine and are unreliable — let the GitHub Actions workflow handle those.

```bash
npm run dist:mac      # produces dist/Bugzilla-AI-Triage-<v>-{arm64,x64}.dmg
npm run dist:win      # produces dist/Bugzilla-AI-Triage-Setup-<v>.exe (Windows host only)
npm run dist:linux    # produces dist/Bugzilla AI Triage-<v>.AppImage
npm run dist:dir      # unpacked .app bundle in dist/, faster for debugging
```

Output goes to `dist/` (gitignored). Each script chains `next build` first, which writes `.next/standalone` — the actual server payload that electron-builder packs into `<resources>/app/`.

### Cutting a release

The canonical Windows `.exe` build happens on a GitHub Actions `windows-latest` runner — local Mac/Linux developers can't produce a real signed `.exe` from their machine. To cut a release:

```bash
git tag v0.2.0
git push --tags
```

The `.github/workflows/release.yml` workflow builds installers for all three platforms in parallel and attaches them to a **draft** GitHub Release. Review the draft, write release notes, then publish.

Manual dry-run: trigger `Release installer` from the Actions tab via *workflow_dispatch* — same builds, no release attachment.

### Differences vs the CLI version

| | bugzilla-triage-dashboard (CLI) | bugzilla-triage-desktop (this repo) |
|---|---|---|
| Target user | Engineers with Claude Code | Anyone, no tooling required |
| AI provider | Local `claude` CLI (your Claude Code subscription) | Anthropic API directly (your API key) |
| Bugzilla layer | Python via `bugzilla-mcp` clone + `uv` + skills | Pure TypeScript |
| Config | `.mcp.json` in `bugzilla-mcp/` | In-app `/settings` page → JSON file |
| Distribution | `git clone` + `npm run dev` | Downloadable `.exe` / `.dmg` / `.AppImage` |
| TLS skip for self-signed certs | `BUGZILLA_INSECURE=true` env var | Checkbox on the settings page |

The two share a lot of UI code at the moment; expect them to drift over time as the desktop build picks up its own features (offline cache, system tray, code signing, auto-update).

### What's not in this build (vs. the CLI version)

The original CLI build's umsemi-specific workflow conventions are preserved verbatim:
- 4-layer **OBSERVED / INFERRED / HYPOTHESIS / NEXT-STEPS** scaffold in `lib/llm.ts` `SYSTEM_PROMPT`
- The `Analyzed by AI Triage Bot:` comment prefix and `Analyzed by AI Triage Bot` `cf_label` are auto-applied by `lib/bugzilla.ts` `submit()` on the AI-triage path (manual triage skips both). Up to v0.1.2 these were `"Analyzed by Claude:"` / `"Analyzed by Claude"`; renamed in v0.1.3 so the labels stay accurate when triage is run against non-Anthropic models. The dashboard recognizes both the new and the legacy strings so tickets analyzed before the rename still show with the AI styling.
- Same `VALID_RESOLUTIONS` vocabulary (FIXED, WONT_FIX, DUPLICATE, etc.)

What's gone:
- The 3GPP domain classifier prefix that the CLI version's Python `domain_3gpp.py` added before the prompt — the model identifies the domain unaided in practice, so the classifier wasn't pulling its weight.

---

## Configuration reference

For most users the Settings page is all you need. The fields below are useful if you're scripting an install for a team — e.g. an IT admin pre-seeding `settings.json` before handing the laptop to a user.

### `settings.json` schema

```json
{
  "version": 1,
  "settings": {
    "bugzillaUrl": "https://bugzilla.example.com",
    "bugzillaApiKey": "40-character-api-key",
    "bugzillaInsecure": true,
    "bugzillaLogin": "user@example.com",
    "anthropicApiKey": "sk-ant-…",
    "defaultModel": "claude-opus-4-7"
  }
}
```

Write this file at the OS-appropriate path above with permissions `0600`, then launch the app — it'll pick it up on first run and skip the setup banner.

### Environment-variable fallbacks (dev only)

For local development without writing `settings.json`, the server falls back to these env vars (file values override env on conflict):

| Env var | Field |
|---|---|
| `BUGZILLA_URL` | `bugzillaUrl` |
| `BUGZILLA_API_KEY` | `bugzillaApiKey` |
| `BUGZILLA_INSECURE` | `bugzillaInsecure` (defaults to `true`) |
| `BUGZILLA_LOGIN` | `bugzillaLogin` |
| `ANTHROPIC_API_KEY` | `anthropicApiKey` |
| `TRIAGE_MODEL` | `defaultModel` |
| `SETTINGS_PATH` | overrides the on-disk file path entirely |
| `PORT` | port the Next.js standalone server listens on (default 3000) |

---

## Privacy & data handling

The app makes outbound network calls only to:

1. **Your Bugzilla server** — for ticket reads and the auto-prefixed comment submit. URL is whatever you configure.
2. **`api.anthropic.com`** — only when you click *Run AI Triage* or *Bulk AI triage*, and only if you've configured an Anthropic API key.

Nothing is sent to the package author, to Anthropic without your explicit AI action, or to any analytics endpoint. There is no telemetry, no auto-update phone-home (yet — we'll surface this clearly when we add it).

Outbound traffic from the Electron main process itself is limited to: Electron's own runtime (Chromium's update channel — disabled in packaged builds), and any URLs the renderer fetches as part of normal Next.js operation against your `localhost:3000`.

---

## Known limitations

- **Code signing**: Windows `.exe` is unsigned, macOS `.dmg` is ad-hoc signed. Users will see "Unknown publisher" / "unidentified developer" warnings. Code-signing certs add ~$200–500/year; will be configured in CI when an org claims the artifact.
- **Encrypted secrets at rest**: API keys in `settings.json` are plaintext under `0600`. The OS-keychain (`safeStorage`) integration is queued as a follow-up.
- **Auto-update**: Not wired. Users get a new release by downloading the new installer from the Releases page. `electron-updater` integration is a future addition.
- **Cross-device sync of saved filters**: Stored in browser localStorage inside the app; clearing app data forgets them.

---

## License

TBD — please confirm before public distribution.
