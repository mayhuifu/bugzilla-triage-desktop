"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Save, Eye, EyeOff, CheckCircle2, AlertCircle, Loader2, ArrowLeft,
  Database, Bot, Lock, Zap, Monitor, Sun, Moon, Palette,
} from "lucide-react";
import { Logo } from "@/components/ui/Logo";
import { CorpusSection } from "@/components/settings/CorpusSection";

// Settings page — first thing a non-technical user sees on a fresh
// install. Two sections (Bugzilla, AI Triage) plus the on-disk file
// location at the bottom so an IT admin can audit / pre-seed the file.
//
// Secrets policy: input fields for API keys are write-only. The GET
// response sends `hasBugzillaApiKey` / `hasAnthropicApiKey` booleans
// only — never the raw key. Leaving an input blank on save preserves
// the existing stored value (handled server-side).

type LlmProvider = "anthropic" | "openai-compatible" | "claude-cli" | "codex-cli";
type ThemeMode = "system" | "light" | "dark";

interface SettingsView {
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
  hasAnthropicApiKey: boolean;
  filePath: string;
  configured: boolean;
}

// Known Anthropic models that get their own dropdown entries. Anything else
// falls into "Custom…" with a free-text input — needed for OpenAI-compatible
// providers (gpt-4o, qwen2.5, deepseek-r1, …) and for proxies that rename
// models.
const KNOWN_MODELS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
] as const;

export default function SettingsPage() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // "Test connection" result. null = idle; otherwise the latest outcome.
  // We DON'T clear this on field edits — useful for the user to compare
  // "this used to work" against the new state.
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Form state. API keys default to empty — the "(saved)" indicator is
  // sourced from `view.hasFooKey` not from the input value.
  const [bugzillaUrl, setBugzillaUrl] = useState("");
  const [bugzillaApiKey, setBugzillaApiKey] = useState("");
  const [bugzillaInsecure, setBugzillaInsecure] = useState(true);
  const [bugzillaLogin, setBugzillaLogin] = useState("");
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("claude-opus-4-7");
  const [showBugzillaKey, setShowBugzillaKey] = useState(false);
  const [showAnthropicKey, setShowAnthropicKey] = useState(false);

  // LLM provider + base URL. modelMode tracks whether the dropdown is on a
  // known Anthropic model or on "custom" (in which case a free-text input
  // is shown for `defaultModel`).
  const [llmProvider, setLlmProvider] = useState<LlmProvider>("anthropic");
  const [llmBaseUrl, setLlmBaseUrl] = useState("");
  const [modelMode, setModelMode] = useState<"known" | "custom">("known");
  const [themeMode, setThemeMode] = useState<ThemeMode>("system");
  // Corpus manifest URL — China users override this to point at an
  // internal SharePoint mirror. The CorpusSection card lets them edit
  // the value inline and trigger a download against the new URL; the
  // change persists alongside the rest of the settings on Save.
  const [corpusManifestUrl, setCorpusManifestUrl] = useState("");

  // Initial load.
  useEffect(() => {
    fetch("/api/settings")
      .then(r => r.json())
      .then((v: SettingsView) => {
        setView(v);
        setBugzillaUrl(v.bugzillaUrl);
        setBugzillaInsecure(v.bugzillaInsecure);
        setBugzillaLogin(v.bugzillaLogin);
        setLlmProvider(v.llmProvider);
        setLlmBaseUrl(v.llmBaseUrl);
        setDefaultModel(v.defaultModel);
        setThemeMode(v.themeMode);
        setCorpusManifestUrl(v.corpusManifestUrl);
        // If the stored model isn't a known Anthropic preset, drop the
        // dropdown into "custom" mode so the user sees what's persisted.
        setModelMode(
          (KNOWN_MODELS as readonly string[]).includes(v.defaultModel) ? "known" : "custom",
        );
      })
      .finally(() => setLoading(false));
  }, []);

  // When the user flips the provider, auto-switch the model picker into
  // custom-text mode for openai-compatible (since the Anthropic presets
  // don't apply). Going back to Anthropic leaves whatever they had.
  const onProviderChange = useCallback((next: LlmProvider) => {
    setLlmProvider(next);
    if (next === "openai-compatible") {
      setModelMode("custom");
      // Clear the Anthropic preset if it's still there — the user almost
      // certainly doesn't want to send "claude-opus-4-7" to a non-Anthropic
      // endpoint. Leave the field empty so they type the right name.
      if ((KNOWN_MODELS as readonly string[]).includes(defaultModel)) {
        setDefaultModel("");
      }
    }
  }, [defaultModel]);

  // Test the Bugzilla connection without saving. Useful before commit so
  // the user can iterate on a wrong URL/key without persisting each try.
  const onTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bugzillaUrl, bugzillaApiKey, bugzillaInsecure }),
      });
      const data = await res.json();
      setTestResult({ ok: Boolean(data.ok), message: data.message || "Unknown result" });
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }, [bugzillaUrl, bugzillaApiKey, bugzillaInsecure]);

  const onSave = useCallback(async () => {
    setSaving(true);
    setErrors([]);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bugzillaUrl, bugzillaApiKey, bugzillaInsecure, bugzillaLogin,
          llmProvider, llmBaseUrl, anthropicApiKey, defaultModel,
          themeMode,
          corpusManifestUrl,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrors(data.errors || [data.error || "Save failed"]);
        return;
      }
      setView(data);
      setBugzillaApiKey("");      // clear write-only fields after save
      setAnthropicApiKey("");
      setSavedAt(Date.now());
      // Notify ThemeManager so the new theme applies immediately without
      // requiring a reload.
      try {
        window.dispatchEvent(
          new CustomEvent("bugzilla-theme-changed", { detail: { themeMode } }),
        );
      } catch { /* SSR / browsers without CustomEvent — ignore */ }
    } catch (err) {
      setErrors([err instanceof Error ? err.message : "Unknown error"]);
    } finally {
      setSaving(false);
    }
  }, [
    bugzillaUrl, bugzillaApiKey, bugzillaInsecure, bugzillaLogin,
    llmProvider, llmBaseUrl, anthropicApiKey, defaultModel, themeMode,
    corpusManifestUrl,
  ]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-bg-border bg-bg-panel/60 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-3xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/"><Logo /></Link>
            <div className="text-xs text-slate-500">
              <span className="text-slate-400">Settings</span>
            </div>
          </div>
          <Link href="/" className="btn-ghost text-xs">
            <ArrowLeft className="w-3.5 h-3.5" /> Back to dashboard
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Settings</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Connect the app to your Bugzilla instance. The dashboard reads tickets through
            this connection — nothing leaves your machine without your explicit approval.
          </p>
        </div>

        {loading && (
          <div className="card p-6 flex items-center gap-3">
            <Loader2 className="w-4 h-4 animate-spin text-accent" />
            <span className="text-sm text-slate-400">Loading current settings…</span>
          </div>
        )}

        {!loading && view && (
          <>
            {/* ── Bugzilla section ───────────────────────────── */}
            <section className="card p-5 space-y-4">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-accent" />
                <h2 className="text-sm font-medium text-slate-200">Bugzilla connection</h2>
                {view.configured && (
                  <span className="badge text-[10px] bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/30 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> connected
                  </span>
                )}
              </div>

              <Field label="Bugzilla URL" hint="e.g. https://ticketing.internal.umsemi.com">
                <input
                  type="url"
                  className="input"
                  value={bugzillaUrl}
                  onChange={e => setBugzillaUrl(e.target.value)}
                  placeholder="https://bugzilla.example.com"
                />
              </Field>

              <Field
                label="Bugzilla API key"
                hint={
                  view.hasBugzillaApiKey
                    ? "Leave blank to keep the stored key. Type to replace it."
                    : "Find this under Preferences → API Keys in Bugzilla."
                }
                rightHint={view.hasBugzillaApiKey ? "(saved)" : undefined}
              >
                <div className="relative">
                  <input
                    type={showBugzillaKey ? "text" : "password"}
                    className="input pr-9"
                    value={bugzillaApiKey}
                    onChange={e => setBugzillaApiKey(e.target.value)}
                    placeholder={view.hasBugzillaApiKey ? "•••••••••••••••••••••••" : ""}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setShowBugzillaKey(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                    title={showBugzillaKey ? "Hide" : "Show"}
                  >
                    {showBugzillaKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </Field>

              <Field label="Your login email" hint="Used to filter 'My Tickets'. Must match your Bugzilla account.">
                <input
                  type="email"
                  className="input"
                  value={bugzillaLogin}
                  onChange={e => setBugzillaLogin(e.target.value)}
                  placeholder="you@company.com"
                />
              </Field>

              <label className="flex items-start gap-2 cursor-pointer select-none p-2 rounded-md bg-bg-panel/40 hover:bg-bg-panel/60 border border-bg-border/40">
                <input
                  type="checkbox"
                  checked={bugzillaInsecure}
                  onChange={e => setBugzillaInsecure(e.target.checked)}
                  className="mt-0.5 w-3.5 h-3.5 accent-accent"
                />
                <div className="flex-1">
                  <div className="text-xs text-slate-200">Skip TLS verification</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    Enable for internal Bugzilla instances using self-signed certificates.
                    Disable for public Bugzilla deployments with valid certs.
                  </div>
                </div>
              </label>

              {/* Test connection — runs without saving so the user can
                  iterate on credentials without committing each attempt. */}
              <div className="pt-2 border-t border-bg-border/40 space-y-2">
                <button
                  onClick={onTest}
                  disabled={testing || !bugzillaUrl}
                  className="btn-secondary text-xs"
                  type="button"
                >
                  {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                  {testing ? "Testing…" : "Test connection"}
                </button>
                {testResult && (
                  <div
                    role="status"
                    className={`text-xs flex items-start gap-2 rounded-md p-2.5 ${
                      testResult.ok
                        ? "bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/30"
                        : "bg-red-500/10 text-red-300 ring-1 ring-red-500/30"
                    }`}
                  >
                    {testResult.ok
                      ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      : <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
                    <span className="break-words">{testResult.message}</span>
                  </div>
                )}
              </div>
            </section>

            {/* ── AI Triage section (optional) ───────────────── */}
            <section className="card p-5 space-y-4">
              <div className="flex items-center gap-2">
                <Bot className="w-4 h-4 text-fuchsia-400" />
                <h2 className="text-sm font-medium text-slate-200">AI triage (optional)</h2>
                {view.hasAnthropicApiKey && (
                  <span className="badge text-[10px] bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/30 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> configured
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500">
                The dashboard works without this. Add a provider + API key here if you want
                the AI triage panel on ticket detail pages. Anthropic users can get a key at{" "}
                <a href="https://console.anthropic.com" target="_blank" rel="noreferrer"
                   className="text-accent-glow hover:underline">console.anthropic.com</a>.
              </p>

              <Field
                label="Provider"
                hint={
                  llmProvider === "anthropic"
                    ? "Calls api.anthropic.com directly using the @anthropic-ai/sdk."
                    : llmProvider === "claude-cli"
                      ? "Spawns the local `claude` CLI in headless mode (`claude -p`). Uses the Claude Code subscription on this machine — no API key needed. Selected automatically when the dev server is launched from inside a `claude` session."
                      : llmProvider === "codex-cli"
                        ? "Spawns the local `codex` CLI in headless mode (`codex exec`). Uses the ChatGPT subscription on this machine — no API key needed. Run `codex login` once to sign in. Supports inline image attachments via `-i`."
                        : "Calls a custom OpenAI-compatible endpoint (Azure, LiteLLM proxy, Ollama, OpenRouter, vLLM, …)."
                }
              >
                <select
                  className="input"
                  value={llmProvider}
                  onChange={e => onProviderChange(e.target.value as LlmProvider)}
                >
                  <option value="anthropic">Anthropic (default)</option>
                  <option value="claude-cli">Claude Code CLI (use my subscription)</option>
                  <option value="codex-cli">OpenAI Codex CLI (use my ChatGPT subscription)</option>
                  <option value="openai-compatible">OpenAI-compatible (custom URL)</option>
                </select>
              </Field>

              {llmProvider !== "claude-cli" && llmProvider !== "codex-cli" && (
                <Field
                  label={llmProvider === "anthropic" ? "API base URL (optional)" : "API base URL"}
                  hint={
                    llmProvider === "anthropic"
                      ? "Leave blank for the default https://api.anthropic.com. Set this only if you route through a corporate proxy or Anthropic-compatible gateway."
                      : "Required. The /v1 endpoint of your provider — e.g. https://api.openai.com/v1, https://api.openrouter.ai/api/v1, http://localhost:11434/v1 (Ollama)."
                  }
                >
                  <input
                    type="url"
                    className="input"
                    value={llmBaseUrl}
                    onChange={e => setLlmBaseUrl(e.target.value)}
                    placeholder={
                      llmProvider === "anthropic"
                        ? "https://api.anthropic.com"
                        : "https://api.openai.com/v1"
                    }
                  />
                </Field>
              )}

              {llmProvider !== "claude-cli" && llmProvider !== "codex-cli" && (
                <Field
                  label={llmProvider === "anthropic" ? "Anthropic API key" : "API key"}
                  hint={
                    view.hasAnthropicApiKey
                      ? "Leave blank to keep the stored key. Type to replace it."
                      : llmProvider === "anthropic"
                        ? "Starts with sk-ant-…"
                        : "Provider-specific (sk-…, opaque proxy token, etc.)"
                  }
                  rightHint={view.hasAnthropicApiKey ? "(saved)" : undefined}
                >
                  <div className="relative">
                    <input
                      type={showAnthropicKey ? "text" : "password"}
                      className="input pr-9"
                      value={anthropicApiKey}
                      onChange={e => setAnthropicApiKey(e.target.value)}
                      placeholder={
                        view.hasAnthropicApiKey
                          ? "•••••••••••••••••••••••"
                          : llmProvider === "anthropic" ? "sk-ant-…" : "sk-… or proxy token"
                      }
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      onClick={() => setShowAnthropicKey(v => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                      title={showAnthropicKey ? "Hide" : "Show"}
                    >
                      {showAnthropicKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </Field>
              )}

              {llmProvider === "claude-cli" && (
                <div className="rounded-md border border-bg-border bg-bg-panel/50 px-3 py-2 text-xs text-slate-400">
                  No API key required. Make sure the <code className="text-slate-300">claude</code> CLI is
                  installed on PATH (run <code className="text-slate-300">claude</code> once interactively to
                  sign in). The default model below maps to your Claude Code subscription — pick{" "}
                  <code className="text-slate-300">opus</code>,{" "}
                  <code className="text-slate-300">sonnet</code>, or{" "}
                  <code className="text-slate-300">haiku</code>.
                </div>
              )}

              {llmProvider === "codex-cli" && (
                <div className="rounded-md border border-bg-border bg-bg-panel/50 px-3 py-2 text-xs text-slate-400">
                  No API key required. Install OpenAI Codex CLI
                  (<code className="text-slate-300">npm i -g @openai/codex</code>) and run{" "}
                  <code className="text-slate-300">codex login</code> once to sign in with your
                  ChatGPT subscription. Image attachments are sent natively via{" "}
                  <code className="text-slate-300">codex exec -i</code>; PDFs are server-side
                  text-extracted. Leave the model below blank to use whatever{" "}
                  <code className="text-slate-300">~/.codex/config.toml</code> defaults to, or
                  type a specific id like{" "}
                  <code className="text-slate-300">gpt-5</code> /{" "}
                  <code className="text-slate-300">o3</code>.
                </div>
              )}

              <Field
                label="Default model"
                hint={
                  llmProvider === "claude-cli"
                    ? "Passed to `claude --model`. Use short aliases (opus / sonnet / haiku) or full Anthropic model ids."
                    : llmProvider === "codex-cli"
                      ? "Passed to `codex --model`. Leave blank to use codex's own configured default. Type any GPT or o-series id your ChatGPT subscription has access to (e.g. gpt-5, o3, o4-mini)."
                      : modelMode === "custom"
                        ? "Free-text model ID — must match a model your provider exposes."
                        : "Anthropic model ID used by the triage step."
                }
              >
                <div className="space-y-2">
                  <select
                    className="input"
                    value={modelMode === "custom" ? "__custom__" : defaultModel}
                    onChange={e => {
                      if (e.target.value === "__custom__") {
                        setModelMode("custom");
                      } else {
                        setModelMode("known");
                        setDefaultModel(e.target.value);
                      }
                    }}
                  >
                    <option value="claude-opus-4-7">claude-opus-4-7 — most capable</option>
                    <option value="claude-sonnet-4-6">claude-sonnet-4-6 — balanced</option>
                    <option value="claude-haiku-4-5">claude-haiku-4-5 — fastest, cheapest</option>
                    <option value="__custom__">Custom…</option>
                  </select>
                  {modelMode === "custom" && (
                    <input
                      type="text"
                      className="input"
                      value={defaultModel}
                      onChange={e => setDefaultModel(e.target.value)}
                      placeholder="e.g. gpt-4o-mini, qwen2.5-coder:32b, deepseek-r1"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  )}
                </div>
              </Field>
            </section>

            {/* ── 3GPP spec corpus (optional) ─────────────────── */}
            <CorpusSection
              manifestUrl={corpusManifestUrl}
              onManifestUrlChange={setCorpusManifestUrl}
            />

            {/* ── Appearance ─────────────────────────────────── */}
            <section className="card p-5 space-y-4">
              <div className="flex items-center gap-2">
                <Palette className="w-4 h-4 text-accent" />
                <h2 className="text-sm font-medium text-slate-200">Appearance</h2>
              </div>
              <p className="text-xs text-slate-500">
                Choose your color scheme. <span className="text-slate-300">System</span>{" "}
                follows your OS appearance and updates live if you toggle it without
                restarting the app.
              </p>

              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    { key: "system", label: "System", icon: Monitor,
                      desc: "Follow OS preference" },
                    { key: "light",  label: "Light",  icon: Sun,
                      desc: "Always light" },
                    { key: "dark",   label: "Dark",   icon: Moon,
                      desc: "Always dark" },
                  ] as const
                ).map(opt => {
                  const Icon = opt.icon;
                  const active = themeMode === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setThemeMode(opt.key)}
                      className={`card p-3 text-left transition-colors ${
                        active
                          ? "ring-2 ring-accent border-accent/40"
                          : "hover:bg-bg-hover"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <Icon className={`w-4 h-4 ${active ? "text-accent" : "text-slate-400"}`} />
                        <span className={`text-xs font-medium ${active ? "text-slate-100" : "text-slate-200"}`}>
                          {opt.label}
                        </span>
                        {active && (
                          <CheckCircle2 className="w-3.5 h-3.5 text-accent ml-auto" />
                        )}
                      </div>
                      <div className="text-[10px] text-slate-500 leading-snug">
                        {opt.desc}
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="text-[10px] text-slate-500">
                Takes effect when you save.
              </div>
            </section>

            {/* ── Errors / Save ───────────────────────────────── */}
            {errors.length > 0 && (
              <div className="card border-red-500/30 bg-red-950/20 p-3 space-y-1">
                {errors.map((e, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-red-300">
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>{e}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-3 sticky bottom-4 bg-bg-panel/90 backdrop-blur-sm card p-3 ring-1 ring-bg-border">
              <button
                onClick={onSave}
                disabled={saving}
                className="btn-primary text-sm"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {saving ? "Saving…" : "Save settings"}
              </button>
              {savedAt && Date.now() - savedAt < 5000 && (
                <span className="text-xs text-emerald-300 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Saved · settings active now
                </span>
              )}
              <Link href="/" className="btn-ghost text-xs ml-auto">
                Back to dashboard
              </Link>
            </div>

            {/* ── File location footer ────────────────────────── */}
            <div className="text-[11px] text-slate-600 flex items-start gap-2 px-1">
              <Lock className="w-3 h-3 mt-0.5 shrink-0" />
              <div>
                Stored at <code className="text-slate-500 font-mono">{view.filePath}</code> with
                owner-only file permissions (0600). API keys are stored as plaintext in this
                milestone; the upcoming Electron build will encrypt them at rest using the OS
                keychain.
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// Reusable labeled field — keeps the section markup readable.
function Field({
  label, hint, rightHint, children,
}: {
  label: string;
  hint?: string;
  rightHint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <label className="text-xs font-medium text-slate-300">{label}</label>
        {rightHint && <span className="text-[10px] text-emerald-400">{rightHint}</span>}
      </div>
      {children}
      {hint && <div className="text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}
