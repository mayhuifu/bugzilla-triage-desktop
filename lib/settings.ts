// ─────────────────────────────────────────────────────────────────
// Settings storage — Bugzilla + Anthropic credentials.
//
// Goal: a non-technical user installs the Windows app, double-clicks
// it, lands on a /settings page, fills in their Bugzilla URL + API
// key + login, and the dashboard works. No env vars, no .mcp.json,
// no terminal.
//
// Storage strategy:
//   - One JSON file at <userDataDir>/bugzilla-triage-desktop/settings.json
//   - File perms set to 0o600 (owner read/write only) on POSIX
//   - In-memory cached on the Next.js server side, invalidated on save
//
// Encryption: settings are stored plaintext under the per-user data
// directory in this milestone. Milestone 4 swaps in Electron's
// `safeStorage` (OS keychain on Win/macOS, secret-service on Linux)
// to encrypt the Bugzilla and Anthropic keys at rest. The file
// schema is unchanged across that swap — only the read/write
// adapter changes — so settings written today survive the upgrade.
//
// Server-side only. Importing this from client components will fail
// to compile because of the "server-only" sentinel.
// ─────────────────────────────────────────────────────────────────

import "server-only";
import * as fs from "node:fs";
import * as path from "node:path";
import { appDataDir } from "./paths";
export { appDataDir };
import { getCurrentUser } from "./users/context";

const SETTINGS_FILE_NAME = "settings.json";
const SCHEMA_VERSION = 1;

/** Which SDK the triage step uses.
 *
 *  - "anthropic"          → @anthropic-ai/sdk, default baseURL https://api.anthropic.com.
 *                           Supports output_config.format for server-side JSON schema
 *                           validation. The original (and recommended) path.
 *  - "openai-compatible"  → openai SDK pointed at a user-supplied baseURL.
 *                           Works with any provider that speaks the OpenAI
 *                           Chat Completions API: OpenAI itself, Azure OpenAI,
 *                           LiteLLM proxy, Ollama, LM Studio, etc.
 *  - "claude-cli"         → spawn the local `claude` CLI in headless mode
 *                           (`claude -p --output-format json`). Uses the
 *                           authenticated Claude Code subscription on the
 *                           host machine — no API key needed. Selected
 *                           automatically when the dev server is launched
 *                           from inside a Claude Code session
 *                           (process.env.CLAUDECODE === "1") and no
 *                           Anthropic API key is stored.
 *  - "codex-cli"          → spawn the local `codex` CLI (OpenAI Codex) in
 *                           headless mode (`codex exec --skip-git-repo-check
 *                           --sandbox read-only --ephemeral`). Uses the
 *                           authenticated ChatGPT subscription on the host
 *                           machine — no API key needed. Supports native
 *                           image input via the CLI's `-i / --image` flag;
 *                           PDFs go through our text-extraction path same
 *                           as the OpenAI-compatible branch. Auto-detect
 *                           is opt-in only (no env signal as clean as
 *                           CLAUDECODE=1) — pick it explicitly in Settings.
 */
export type LlmProvider = "anthropic" | "openai-compatible" | "claude-cli" | "codex-cli";

/** Theme preference, persisted to settings.json (added in v0.1.4).
 *  - "system" (default): follow prefers-color-scheme; live-updates if the
 *    user changes their OS appearance while the app is open.
 *  - "light" / "dark": explicit override, ignores the system setting. */
export type ThemeMode = "system" | "light" | "dark";

export interface Settings {
  bugzillaUrl: string;          // e.g. https://ticketing.internal.umsemi.com
  bugzillaApiKey: string;       // 40-char API key from Bugzilla
  bugzillaInsecure: boolean;    // skip TLS verification (for self-signed corp certs)
  bugzillaLogin: string;        // email — used as the /rest/whoami fallback

  // ── LLM (AI triage) ────────────────────────────────────────────
  // Field-naming note: `anthropicApiKey` is kept verbatim from v0.1.x for
  // backwards compatibility with already-saved settings.json files. Despite
  // the name, it stores whichever provider's key the user configured —
  // it's an "Anthropic key" when llmProvider="anthropic", or the OpenAI /
  // proxy key when llmProvider="openai-compatible". Don't rename without a
  // migration step in loadSettings().
  llmProvider: LlmProvider;     // which SDK to use for triage
  llmBaseUrl: string;           // empty → SDK default; required when openai-compatible
  anthropicApiKey: string;      // see naming note above
  defaultModel: string;         // model ID (e.g. claude-opus-4-7 or gpt-4o-mini)

  // ── Appearance ─────────────────────────────────────────────────
  themeMode: ThemeMode;         // "system" follows prefers-color-scheme

  // ── 3GPP RAG corpus (added in v0.1.6) ──────────────────────────
  // The desktop app downloads a SQLite spec corpus on user opt-in so AI
  // triage can cite real 3GPP clause text instead of model paraphrase.
  // All three fields are optional and gracefully degrade when unset.
  /** URL of the corpus manifest JSON. Defaults to the GitHub Releases
   *  manifest published from the bugzilla-triage-corpus repo. Users in
   *  GitHub-blocked networks (e.g. mainland China) override this to point
   *  at an internal mirror (SharePoint, Confluence, S3, etc.) — the
   *  manifest's `url` field then determines where the actual .sqlite.gz
   *  is fetched from, so the override flows through. */
  corpusManifestUrl: string;
  /** The corpus version currently installed on this machine, e.g.
   *  "rel17-v1". Compared against the remote manifest's `tag` field to
   *  detect when an update is available. Empty when nothing is installed. */
  corpusVersion: string;
  /** When true, on app launch the manifest is fetched and a newer version
   *  is downloaded automatically. v0.1.6 keeps this OFF by default — the
   *  user opts in via Settings → "Check for updates" instead. */
  corpusAutoUpdate: boolean;
}

interface StoredEnvelope {
  version: number;
  settings: Settings;
}

/** Default corpus manifest URL — the STABLE-NAMED alias on the corpus
 *  repo's `releases/latest`. Every corpus release (from rel17-v7 on)
 *  uploads its manifest twice: once under the versioned name and once as
 *  `corpus-latest.manifest.json`; GitHub's `releases/latest/download/…`
 *  redirect then always serves the newest one. This is what lets the
 *  Settings card's "check for update" DISCOVER new corpus releases —
 *  the old per-tag default URLs could only ever re-fetch the release
 *  they were pinned to, so a new tag was invisible until a desktop
 *  release bumped the hard-coded URL (the rel17-v6 → v7 gap).
 *  The manifest's artifact.url stays versioned, so downloads + sha256
 *  verification are unchanged. */
const DEFAULT_CORPUS_MANIFEST_URL =
  "https://github.com/mayhuifu/bugzilla-triage-corpus/releases/latest/download/corpus-latest.manifest.json";

/** Legacy default URLs we've shipped. When a user's saved settings.json
 *  still has one of these (i.e. they accepted the default at install
 *  time and never edited it), we silently upgrade to the current default
 *  on load. Users who DID customise the URL (e.g. internal mirror) keep
 *  their value — we only rewrite if it's an exact match for a previous
 *  shipped default.
 *
 *  Note: v4 is included here so users on the bge-m3 corpus auto-upgrade to
 *  the bge-small v5 corpus that matches the bundled embedder. (Staying on
 *  v4 is harmless — it just runs BM25 — but v5 unlocks hybrid.) */
const LEGACY_DEFAULT_CORPUS_MANIFEST_URLS = new Set([
  "https://github.com/mayhuifu/bugzilla-triage-corpus/releases/download/rel17-v1/3gpp-corpus-rel17-v1-2026-05.manifest.json",
  "https://github.com/mayhuifu/bugzilla-triage-corpus/releases/download/rel17-v2/3gpp-corpus-rel17-v2-2026-05.manifest.json",
  "https://github.com/mayhuifu/bugzilla-triage-corpus/releases/download/rel17-v3/3gpp-corpus-rel17-v3-2026-05.manifest.json",
  "https://github.com/mayhuifu/bugzilla-triage-corpus/releases/download/rel17-v4/3gpp-corpus-rel17-v4-2026-05.manifest.json",
  "https://github.com/mayhuifu/bugzilla-triage-corpus/releases/download/rel17-v5/3gpp-corpus-rel17-v5-2026-05.manifest.json",
  // v6 was the default through desktop v0.7.11 — remap to the stable alias
  // so those users' "check for update" starts discovering new releases.
  "https://github.com/mayhuifu/bugzilla-triage-corpus/releases/download/rel17-v6/3gpp-corpus-rel17-v6-2026-06.manifest.json",
]);

const EMPTY_SETTINGS: Settings = {
  bugzillaUrl: "",
  bugzillaApiKey: "",
  bugzillaInsecure: true,
  bugzillaLogin: "",
  llmProvider: "anthropic",
  llmBaseUrl: "",
  anthropicApiKey: "",
  defaultModel: "claude-opus-4-8",
  themeMode: "system",
  corpusManifestUrl: DEFAULT_CORPUS_MANIFEST_URL,
  corpusVersion: "",
  corpusAutoUpdate: false,
};

// ── Where the file lives ──────────────────────────────────────────

// appDataDir() now lives in ./paths (imported + re-exported near the top) — a
// pure path helper free of the `server-only` marker so dev/CLI scripts can use it.

function settingsPath(): string {
  // SETTINGS_PATH env override exists primarily for tests and for the
  // Electron main process to point at app.getPath("userData") explicitly.
  return process.env.SETTINGS_PATH || path.join(appDataDir(), SETTINGS_FILE_NAME);
}

// ── Read with env-var fallback ────────────────────────────────────

let _cache: Settings | null = null;

/** Merge env-var defaults under the file contents. Env still works for
 * developer workflows (no settings file → reads BUGZILLA_URL / etc.),
 * but the file wins once the user has saved anything. */
function envSettings(): Settings {
  const provider = (process.env.LLM_PROVIDER || "").toLowerCase();
  // Auto-detect Claude Code CLI: when the desktop's Next.js dev server is
  // launched from inside a `claude` session, CLAUDECODE=1 is set in the
  // child environment. If the user hasn't explicitly picked another
  // provider AND has no Anthropic API key configured, route triage
  // through the local `claude` subprocess so it uses the host's Claude
  // subscription (no API key). The user can still override via
  // LLM_PROVIDER=anthropic or by saving a provider in Settings.
  const inClaudeCode = process.env.CLAUDECODE === "1";
  const noKey = !process.env.ANTHROPIC_API_KEY;
  const llmProvider: LlmProvider =
    provider === "claude-cli"
      ? "claude-cli"
      : provider === "codex-cli"
        ? "codex-cli"
        : provider === "openai-compatible"
          ? "openai-compatible"
          : provider === "anthropic"
            ? "anthropic"
            : inClaudeCode && noKey
              ? "claude-cli"
              : "anthropic";
  const themeEnv = (process.env.THEME_MODE || "").toLowerCase();
  const themeMode: ThemeMode =
    themeEnv === "light" || themeEnv === "dark" || themeEnv === "system"
      ? (themeEnv as ThemeMode)
      : "system";
  return {
    bugzillaUrl: (process.env.BUGZILLA_URL || "").replace(/\/$/, ""),
    bugzillaApiKey: process.env.BUGZILLA_API_KEY || "",
    bugzillaInsecure: (process.env.BUGZILLA_INSECURE || "true").toLowerCase() === "true",
    bugzillaLogin: process.env.BUGZILLA_LOGIN || "",
    llmProvider,
    llmBaseUrl: (process.env.LLM_BASE_URL || "").trim().replace(/\/$/, ""),
    // OPENAI_API_KEY honored as a fallback when LLM_PROVIDER=openai-compatible
    // so devs can `export OPENAI_API_KEY=…` without re-typing in the UI.
    anthropicApiKey:
      process.env.ANTHROPIC_API_KEY ||
      (llmProvider === "openai-compatible" ? process.env.OPENAI_API_KEY || "" : ""),
    defaultModel: process.env.TRIAGE_MODEL || "claude-opus-4-8",
    themeMode,
    corpusManifestUrl: (process.env.CORPUS_MANIFEST_URL || DEFAULT_CORPUS_MANIFEST_URL).trim(),
    corpusVersion: process.env.CORPUS_VERSION || "",
    corpusAutoUpdate: (process.env.CORPUS_AUTO_UPDATE || "false").toLowerCase() === "true",
  };
}

export function loadSettings(): Settings {
  if (_cache) return _cache;

  const env = envSettings();
  let fromFile: Partial<Settings> = {};
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as StoredEnvelope;
    if (parsed.version === SCHEMA_VERSION && parsed.settings) {
      fromFile = parsed.settings;
    }
  } catch (err) {
    // ENOENT is the normal first-run case — fall through to env-only.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      // Malformed file is worth surfacing so users notice corruption.
      // eslint-disable-next-line no-console
      console.warn(`[settings] failed to read ${settingsPath()}:`, err);
    }
  }

  // File takes precedence — env is the fallback for unset fields.
  // EMPTY_SETTINGS sits underneath so new fields added in a later release
  // (e.g. llmProvider, llmBaseUrl) get safe defaults when reading an older
  // settings.json that pre-dates them — no schema migration needed.
  _cache = { ...EMPTY_SETTINGS, ...env, ...fromFile };

  // One-shot migration: upgrade a still-default-from-an-older-release
  // corpus manifest URL to the current default. If the user kept the
  // shipped URL (which is almost everyone), they get the new corpus
  // release silently. If they customised to an internal mirror, the
  // URL is untouched.
  if (LEGACY_DEFAULT_CORPUS_MANIFEST_URLS.has(_cache.corpusManifestUrl)) {
    _cache = { ..._cache, corpusManifestUrl: DEFAULT_CORPUS_MANIFEST_URL };
  }

  return _cache;
}

export function saveSettings(next: Settings): void {
  const dir = path.dirname(settingsPath());
  fs.mkdirSync(dir, { recursive: true });
  const envelope: StoredEnvelope = { version: SCHEMA_VERSION, settings: next };
  // Write to a temp file then rename — avoids leaving a half-written
  // settings file if the process is killed mid-write. Permissions are
  // set on the temp file before the rename so the final file inherits
  // them atomically.
  const tmp = settingsPath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, settingsPath());
  _cache = next;
}

/** Test/Electron hook — drop the in-memory cache after an out-of-band
 * change (e.g. settings imported by the installer, or edited manually). */
export function invalidateSettingsCache(): void {
  _cache = null;
}

// ── Validation helpers (used by /api/settings) ────────────────────

export function validateSettings(s: Partial<Settings>): string[] {
  const errors: string[] = [];
  if (!s.bugzillaUrl?.trim()) {
    errors.push("Bugzilla URL is required");
  } else if (!/^https?:\/\//.test(s.bugzillaUrl)) {
    errors.push("Bugzilla URL must start with http:// or https://");
  }
  if (!s.bugzillaApiKey?.trim()) {
    errors.push("Bugzilla API key is required");
  }
  if (!s.bugzillaLogin?.trim()) {
    errors.push("Bugzilla login email is required (used as the whoami fallback)");
  } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.bugzillaLogin)) {
    errors.push("Bugzilla login must look like an email address");
  }
  // LLM key shape check is conditional on provider. Anthropic keys have a
  // very recognizable prefix; OpenAI-compatible providers use everything
  // from `sk-…` to opaque proxy tokens, so we don't try to validate format.
  // The claude-cli provider needs neither key nor URL — it uses the
  // local `claude` binary's stored auth.
  if (s.llmProvider === "anthropic" && s.anthropicApiKey && !s.anthropicApiKey.startsWith("sk-ant-")) {
    errors.push("Anthropic API key should start with sk-ant-");
  }
  if (s.llmProvider === "openai-compatible") {
    if (!s.llmBaseUrl?.trim()) {
      errors.push("LLM base URL is required when provider is OpenAI-compatible");
    } else if (!/^https?:\/\//.test(s.llmBaseUrl)) {
      errors.push("LLM base URL must start with http:// or https://");
    }
  } else if (s.llmProvider !== "claude-cli" && s.llmProvider !== "codex-cli"
             && s.llmBaseUrl?.trim() && !/^https?:\/\//.test(s.llmBaseUrl)) {
    // baseURL is optional for Anthropic, but if set must be a valid
    // http(s) URL. claude-cli and codex-cli ignore baseURL entirely
    // (they use the CLI's own auth path) so we don't validate it.
    errors.push("LLM base URL must start with http:// or https://");
  }
  return errors;
}

/** UI-safe redaction: replace the API keys with `hasFoo: boolean`
 * before sending to the browser. We never let the secret round-trip
 * through the client. */
export interface SettingsForUi {
  bugzillaUrl: string;
  bugzillaInsecure: boolean;
  bugzillaLogin: string;
  llmProvider: LlmProvider;
  llmBaseUrl: string;
  defaultModel: string;
  themeMode: ThemeMode;
  corpusManifestUrl: string;
  corpusVersion: string;
  corpusAutoUpdate: boolean;
  hasBugzillaApiKey: boolean;
  hasAnthropicApiKey: boolean;     // legacy name — really "has LLM key set"
  filePath: string;
}

export function settingsForUi(s: Settings): SettingsForUi {
  return {
    bugzillaUrl: s.bugzillaUrl,
    bugzillaInsecure: s.bugzillaInsecure,
    bugzillaLogin: s.bugzillaLogin,
    llmProvider: s.llmProvider,
    llmBaseUrl: s.llmBaseUrl,
    defaultModel: s.defaultModel,
    themeMode: s.themeMode,
    corpusManifestUrl: s.corpusManifestUrl,
    corpusVersion: s.corpusVersion,
    corpusAutoUpdate: s.corpusAutoUpdate,
    hasBugzillaApiKey: Boolean(s.bugzillaApiKey),
    hasAnthropicApiKey: Boolean(s.anthropicApiKey),
    filePath: settingsPath(),
  };
}

export function isBugzillaConfigured(s: Settings = loadSettings()): boolean {
  return Boolean(s.bugzillaUrl && s.bugzillaApiKey);
}

/** True when running as the hosted multi-user server (vs the single-user
 *  desktop build). Gated entirely by the MULTI_USER env flag. */
export function isMultiUser(): boolean {
  return process.env.MULTI_USER === "1";
}

/** The settings to use for the CURRENT operation.
 *  - Desktop mode (default): the global settings.json — byte-identical to today
 *    (early return; the user-context machinery is never touched).
 *  - Server mode (MULTI_USER=1): the env-global base (bugzillaUrl / insecure /
 *    corpus) overlaid with the CURRENT request's user (their Bugzilla key + LLM
 *    config). If the user opted into the company LLM, the LLM fields come from
 *    COMPANY_LLM_* env. Outside any request scope (no current user) returns the
 *    base only. */
export function getEffectiveSettings(): Settings {
  if (!isMultiUser()) return loadSettings();
  const base = loadSettings();
  // In server mode the SHARED Bugzilla endpoint is server-controlled via env —
  // it must NOT be shadowed by a stray settings.json on the host (loadSettings
  // lets the file win over env). Only the API key is per-user; URL + insecure
  // are server-global, so the deploy's BUGZILLA_URL/BUGZILLA_INSECURE win here.
  const serverUrl = (process.env.BUGZILLA_URL || base.bugzillaUrl || "").replace(/\/$/, "");
  const serverInsecure = process.env.BUGZILLA_INSECURE != null
    ? process.env.BUGZILLA_INSECURE.toLowerCase() === "true"
    : base.bugzillaInsecure;
  const u = getCurrentUser();
  if (!u) return { ...base, bugzillaUrl: serverUrl, bugzillaInsecure: serverInsecure };
  const company = u.useCompanyLlm;
  return {
    ...base,
    bugzillaUrl: serverUrl,
    bugzillaInsecure: serverInsecure,
    bugzillaApiKey: u.bugzillaApiKey,
    bugzillaLogin: u.email,
    llmProvider: (company ? (process.env.COMPANY_LLM_PROVIDER || "openai-compatible") : u.llmProvider) as LlmProvider,
    llmBaseUrl: company ? (process.env.COMPANY_LLM_BASE_URL || "") : u.llmBaseUrl,
    anthropicApiKey: company ? (process.env.COMPANY_LLM_API_KEY || "") : u.llmApiKey,
    defaultModel: company ? (process.env.COMPANY_LLM_MODEL || u.defaultModel) : u.defaultModel,
    themeMode: (u.themeMode || base.themeMode) as ThemeMode,
  };
}
