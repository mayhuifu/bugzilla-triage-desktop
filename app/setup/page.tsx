"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Eye, EyeOff, AlertCircle, Loader2,
  Database, Bot, Sparkles,
} from "lucide-react";
import { Logo } from "@/components/ui/Logo";

// Setup page — shown to new users on a multi-user server before they have a
// session. Collects email, Bugzilla API key, and an optional LLM preference,
// then POSTs to /api/setup. On success the API sets a bt_session cookie and
// we redirect home.
//
// No initial GET is needed here — by definition the user has no session yet.
// (The middleware / layout is expected to redirect authenticated users away
// from this route before they land here.)

type LlmProvider = "anthropic" | "openai-compatible" | "claude-cli" | "codex-cli";
type ThemeMode = "system" | "light" | "dark";
type LlmChoice = "company" | "own";

export default function SetupPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Required fields ───────────────────────────────────────────────
  const [email, setEmail] = useState("");
  const [bugzillaApiKey, setBugzillaApiKey] = useState("");
  const [showBugzillaKey, setShowBugzillaKey] = useState(false);

  // ── LLM choice ───────────────────────────────────────────────────
  const [llmChoice, setLlmChoice] = useState<LlmChoice>("company");
  const [llmProvider, setLlmProvider] = useState<LlmProvider>("anthropic");
  const [llmBaseUrl, setLlmBaseUrl] = useState("");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [showLlmKey, setShowLlmKey] = useState(false);
  const [defaultModel, setDefaultModel] = useState("");

  // Theme defaults to system — user can change it in Settings later.
  const themeMode: ThemeMode = "system";

  // When the user flips to openai-compatible, remind them they need a base URL.
  const onProviderChange = useCallback((next: LlmProvider) => {
    setLlmProvider(next);
  }, []);

  const onSubmit = useCallback(async () => {
    setError(null);
    setSubmitting(true);
    try {
      const useCompanyLlm = llmChoice === "company";
      const body: Record<string, unknown> = {
        email: email.trim(),
        bugzillaApiKey: bugzillaApiKey.trim(),
        useCompanyLlm,
        themeMode,
      };
      if (!useCompanyLlm) {
        body.llmProvider = llmProvider;
        if (llmProvider === "openai-compatible") {
          body.llmBaseUrl = llmBaseUrl.trim();
        }
        if (llmProvider !== "claude-cli" && llmProvider !== "codex-cli") {
          body.llmApiKey = llmApiKey.trim();
        }
        if (defaultModel.trim()) {
          body.defaultModel = defaultModel.trim();
        }
      }

      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { ok?: boolean; email?: string; error?: string };

      if (!res.ok || !data.ok) {
        setError(data.error ?? "Setup failed — please try again.");
        return;
      }

      // Session cookie has been set by the server; navigate home.
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error — check your connection.");
    } finally {
      setSubmitting(false);
    }
  }, [
    email, bugzillaApiKey, llmChoice,
    llmProvider, llmBaseUrl, llmApiKey, defaultModel,
    themeMode, router,
  ]);

  return (
    <div className="min-h-screen">
      {/* ── Header ──────────────────────────────────────────────── */}
      <header className="border-b border-bg-border bg-bg-panel/60 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-3xl mx-auto px-6 h-14 flex items-center">
          <Logo subtitle="Workspace setup" />
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        {/* ── Page heading ────────────────────────────────────── */}
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Set up your workspace</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            One-time setup for this internal multi-user server. Your credentials are
            stored encrypted on the server and only used to call Bugzilla and the AI
            provider on your behalf.
          </p>
        </div>

        {/* ── Account section ─────────────────────────────────── */}
        <section className="card p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-accent" />
            <h2 className="text-sm font-medium text-slate-200">Your account</h2>
          </div>

          <Field label="Work email" hint="Must match your Bugzilla account.">
            <input
              type="email"
              className="input"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
              required
            />
          </Field>

          <Field
            label="Bugzilla API key"
            hint="Find this under Preferences → API Keys in Bugzilla."
          >
            <div className="relative">
              <input
                type={showBugzillaKey ? "text" : "password"}
                className="input pr-9"
                value={bugzillaApiKey}
                onChange={e => setBugzillaApiKey(e.target.value)}
                placeholder="Your Bugzilla API key"
                autoComplete="off"
                spellCheck={false}
                required
              />
              <button
                type="button"
                onClick={() => setShowBugzillaKey(v => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                title={showBugzillaKey ? "Hide" : "Show"}
              >
                {showBugzillaKey
                  ? <EyeOff className="w-3.5 h-3.5" />
                  : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </Field>
        </section>

        {/* ── LLM section ─────────────────────────────────────── */}
        <section className="card p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-fuchsia-400" />
            <h2 className="text-sm font-medium text-slate-200">AI provider</h2>
          </div>
          <p className="text-xs text-slate-500">
            The AI triage panel uses a language model to summarise tickets and suggest
            owners. Choose the company-provided default or bring your own provider.
          </p>

          {/* Radio: company vs own */}
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                {
                  key: "company" as const,
                  label: "Use company AI (DeepSeek)",
                  desc: "Pre-configured by your IT admin — no key required.",
                  icon: Sparkles,
                },
                {
                  key: "own" as const,
                  label: "Use my own provider",
                  desc: "Supply your own API key or local CLI.",
                  icon: Bot,
                },
              ] as const
            ).map(opt => {
              const Icon = opt.icon;
              const active = llmChoice === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setLlmChoice(opt.key)}
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
                  </div>
                  <div className="text-[10px] text-slate-500 leading-snug">{opt.desc}</div>
                </button>
              );
            })}
          </div>

          {/* Personal LLM sub-form — only when "own" is chosen */}
          {llmChoice === "own" && (
            <div className="space-y-4 pt-2 border-t border-bg-border/40">
              <Field
                label="Provider"
                hint={
                  llmProvider === "anthropic"
                    ? "Calls api.anthropic.com directly."
                    : llmProvider === "claude-cli"
                      ? "Spawns the local `claude` CLI — no API key needed. Run `claude` once to sign in."
                      : llmProvider === "codex-cli"
                        ? "Spawns the local `codex` CLI — no API key needed. Run `codex login` to sign in."
                        : "Calls a custom OpenAI-compatible endpoint (Azure, LiteLLM, Ollama, OpenRouter, …)."
                }
              >
                <select
                  className="input"
                  value={llmProvider}
                  onChange={e => onProviderChange(e.target.value as LlmProvider)}
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="claude-cli">Claude Code CLI (use my subscription)</option>
                  <option value="codex-cli">OpenAI Codex CLI (use my ChatGPT subscription)</option>
                  <option value="openai-compatible">OpenAI-compatible (custom URL)</option>
                </select>
              </Field>

              {llmProvider === "openai-compatible" && (
                <Field
                  label="API base URL"
                  hint="Required. The /v1 endpoint — e.g. https://api.openai.com/v1 or http://localhost:11434/v1 (Ollama)."
                >
                  <input
                    type="url"
                    className="input"
                    value={llmBaseUrl}
                    onChange={e => setLlmBaseUrl(e.target.value)}
                    placeholder="https://api.openai.com/v1"
                  />
                </Field>
              )}

              {llmProvider !== "claude-cli" && llmProvider !== "codex-cli" && (
                <Field
                  label={llmProvider === "anthropic" ? "Anthropic API key" : "API key"}
                  hint={
                    llmProvider === "anthropic"
                      ? "Starts with sk-ant-… — get one at console.anthropic.com."
                      : "Provider-specific (sk-…, opaque proxy token, etc.)"
                  }
                >
                  <div className="relative">
                    <input
                      type={showLlmKey ? "text" : "password"}
                      className="input pr-9"
                      value={llmApiKey}
                      onChange={e => setLlmApiKey(e.target.value)}
                      placeholder={llmProvider === "anthropic" ? "sk-ant-…" : "sk-… or proxy token"}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      onClick={() => setShowLlmKey(v => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                      title={showLlmKey ? "Hide" : "Show"}
                    >
                      {showLlmKey
                        ? <EyeOff className="w-3.5 h-3.5" />
                        : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </Field>
              )}

              {(llmProvider === "claude-cli" || llmProvider === "codex-cli") && (
                <div className="rounded-md border border-bg-border bg-bg-panel/50 px-3 py-2 text-xs text-slate-400">
                  {llmProvider === "claude-cli"
                    ? <>No API key required. Make sure <code className="text-slate-300">claude</code> is installed on PATH and you have signed in once interactively.</>
                    : <>No API key required. Install with <code className="text-slate-300">npm i -g @openai/codex</code> and run <code className="text-slate-300">codex login</code> once.</>}
                </div>
              )}

              <Field
                label="Default model (optional)"
                hint="Leave blank to use the provider's default. Examples: claude-opus-4-7, gpt-4o, deepseek-r1."
              >
                <input
                  type="text"
                  className="input"
                  value={defaultModel}
                  onChange={e => setDefaultModel(e.target.value)}
                  placeholder="e.g. claude-sonnet-4-6, gpt-4o-mini, deepseek-r1"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            </div>
          )}
        </section>

        {/* ── Inline error ─────────────────────────────────────── */}
        {error && (
          <div className="card border-red-500/30 bg-red-950/20 p-3">
            <div className="flex items-start gap-2 text-xs text-red-300">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          </div>
        )}

        {/* ── Submit ───────────────────────────────────────────── */}
        <div className="flex items-center gap-3 sticky bottom-4 bg-bg-panel/90 backdrop-blur-sm card p-3 ring-1 ring-bg-border">
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitting || !email.trim() || !bugzillaApiKey.trim()}
            className="btn-primary text-sm"
          >
            {submitting
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Setting up…</>
              : "Get started"}
          </button>
          <p className="text-[11px] text-slate-500">
            Your API key is validated against the server&apos;s Bugzilla instance before
            the account is created.
          </p>
        </div>
      </main>
    </div>
  );
}

// ── Reusable labeled field (mirrors app/settings/page.tsx) ─────────
function Field({
  label, hint, children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-slate-300">{label}</label>
      {children}
      {hint && <div className="text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}
