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
import * as os from "node:os";

const SETTINGS_FILE_NAME = "settings.json";
const APP_DIR_NAME = "bugzilla-triage-desktop";
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
 */
export type LlmProvider = "anthropic" | "openai-compatible";

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
}

interface StoredEnvelope {
  version: number;
  settings: Settings;
}

const EMPTY_SETTINGS: Settings = {
  bugzillaUrl: "",
  bugzillaApiKey: "",
  bugzillaInsecure: true,
  bugzillaLogin: "",
  llmProvider: "anthropic",
  llmBaseUrl: "",
  anthropicApiKey: "",
  defaultModel: "claude-opus-4-7",
};

// ── Where the file lives ──────────────────────────────────────────

/** OS-appropriate per-user app-data directory. Mirrors the convention
 * Electron's `app.getPath("userData")` will produce in milestone 4,
 * so settings written now will still be found after we wrap in
 * Electron. */
function appDataDir(): string {
  const platform = os.platform();
  const home = os.homedir();
  if (platform === "win32") {
    // %APPDATA%\bugzilla-triage-desktop
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, APP_DIR_NAME);
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", APP_DIR_NAME);
  }
  // Linux & friends — XDG_CONFIG_HOME or ~/.config
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(xdg, APP_DIR_NAME);
}

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
  const llmProvider: LlmProvider =
    provider === "openai-compatible" ? "openai-compatible" : "anthropic";
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
    defaultModel: process.env.TRIAGE_MODEL || "claude-opus-4-7",
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
  if (s.llmProvider === "anthropic" && s.anthropicApiKey && !s.anthropicApiKey.startsWith("sk-ant-")) {
    errors.push("Anthropic API key should start with sk-ant-");
  }
  if (s.llmProvider === "openai-compatible") {
    if (!s.llmBaseUrl?.trim()) {
      errors.push("LLM base URL is required when provider is OpenAI-compatible");
    } else if (!/^https?:\/\//.test(s.llmBaseUrl)) {
      errors.push("LLM base URL must start with http:// or https://");
    }
  } else if (s.llmBaseUrl?.trim() && !/^https?:\/\//.test(s.llmBaseUrl)) {
    // baseURL is optional for Anthropic, but if set must be a valid http(s) URL.
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
    hasBugzillaApiKey: Boolean(s.bugzillaApiKey),
    hasAnthropicApiKey: Boolean(s.anthropicApiKey),
    filePath: settingsPath(),
  };
}

export function isBugzillaConfigured(s: Settings = loadSettings()): boolean {
  return Boolean(s.bugzillaUrl && s.bugzillaApiKey);
}
