"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Save, Eye, EyeOff, CheckCircle2, AlertCircle, Loader2, ArrowLeft,
  Database, Bot, Lock, Zap,
} from "lucide-react";
import { Logo } from "@/components/ui/Logo";

// Settings page — first thing a non-technical user sees on a fresh
// install. Two sections (Bugzilla, AI Triage) plus the on-disk file
// location at the bottom so an IT admin can audit / pre-seed the file.
//
// Secrets policy: input fields for API keys are write-only. The GET
// response sends `hasBugzillaApiKey` / `hasAnthropicApiKey` booleans
// only — never the raw key. Leaving an input blank on save preserves
// the existing stored value (handled server-side).

interface SettingsView {
  bugzillaUrl: string;
  bugzillaInsecure: boolean;
  bugzillaLogin: string;
  defaultModel: string;
  hasBugzillaApiKey: boolean;
  hasAnthropicApiKey: boolean;
  filePath: string;
  configured: boolean;
}

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

  // Initial load.
  useEffect(() => {
    fetch("/api/settings")
      .then(r => r.json())
      .then((v: SettingsView) => {
        setView(v);
        setBugzillaUrl(v.bugzillaUrl);
        setBugzillaInsecure(v.bugzillaInsecure);
        setBugzillaLogin(v.bugzillaLogin);
        setDefaultModel(v.defaultModel);
      })
      .finally(() => setLoading(false));
  }, []);

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
          anthropicApiKey, defaultModel,
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
    } catch (err) {
      setErrors([err instanceof Error ? err.message : "Unknown error"]);
    } finally {
      setSaving(false);
    }
  }, [
    bugzillaUrl, bugzillaApiKey, bugzillaInsecure, bugzillaLogin,
    anthropicApiKey, defaultModel,
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
                The dashboard works without this. Add an Anthropic API key only if you want
                the AI triage panel on ticket detail pages. Get one at{" "}
                <a href="https://console.anthropic.com" target="_blank" rel="noreferrer"
                   className="text-accent-glow hover:underline">console.anthropic.com</a>.
              </p>

              <Field
                label="Anthropic API key"
                hint={
                  view.hasAnthropicApiKey
                    ? "Leave blank to keep the stored key. Type to replace it."
                    : "Starts with sk-ant-…"
                }
                rightHint={view.hasAnthropicApiKey ? "(saved)" : undefined}
              >
                <div className="relative">
                  <input
                    type={showAnthropicKey ? "text" : "password"}
                    className="input pr-9"
                    value={anthropicApiKey}
                    onChange={e => setAnthropicApiKey(e.target.value)}
                    placeholder={view.hasAnthropicApiKey ? "•••••••••••••••••••••••" : "sk-ant-…"}
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

              <Field label="Default model" hint="Anthropic model ID used by the triage step.">
                <select
                  className="input"
                  value={defaultModel}
                  onChange={e => setDefaultModel(e.target.value)}
                >
                  <option value="claude-opus-4-7">claude-opus-4-7 — most capable</option>
                  <option value="claude-sonnet-4-6">claude-sonnet-4-6 — balanced</option>
                  <option value="claude-haiku-4-5">claude-haiku-4-5 — fastest, cheapest</option>
                </select>
              </Field>
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
