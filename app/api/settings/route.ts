import { NextRequest, NextResponse } from "next/server";
import {
  loadSettings, saveSettings, validateSettings, settingsForUi,
  isBugzillaConfigured, isMultiUser, getEffectiveSettings, type Settings,
} from "@/lib/settings";
import { bumpServerCacheVersion } from "@/lib/server-cache";
import { withUser } from "@/lib/users/with-user";
import { getCurrentUser } from "@/lib/users/context";
import { upsertUser } from "@/lib/users/store";

export const dynamic = "force-dynamic";

// GET — return the settings the UI should display. Secrets are stripped
// here: the page never sees the raw Bugzilla or Anthropic API keys, only
// a `hasFooKey` boolean for the "(saved)" indicator next to the input.
export const GET = withUser(async () => {
  // Server mode → the EFFECTIVE settings (env Bugzilla URL + this user's
  // encrypted profile key/LLM). Desktop mode → the single settings.json.
  // Using loadSettings() here was the bug that made every server user look
  // "not configured" no matter what they registered at /setup.
  const settings = getEffectiveSettings();
  return NextResponse.json({
    ...settingsForUi(settings),
    configured: isBugzillaConfigured(settings),
    multiUser: isMultiUser(),
  });
});

// POST — validate + persist. The page sends every editable field every
// time. Secrets are handled with a sentinel: the page sends "" if the user
// didn't touch the field, and we keep the prior stored value in that
// case. That lets a user save a URL change without re-typing their API key.
export const POST = withUser(async (req: Request) => {
  let body: Partial<Settings>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // ── Server mode: update the CURRENT user's per-user profile ──────────
  // Bugzilla URL/insecure + the spec corpus are server-global (env) and are
  // NOT editable here; only the per-user fields (API key, LLM provider/base/
  // key, model, theme) are written to the encrypted profile. Secrets use the
  // write-only sentinel — a blank field keeps the stored value. (`useCompanyLlm`
  // is toggled only at /setup, so it's preserved here.)
  if (isMultiUser()) {
    const u = getCurrentUser();
    if (!u) return NextResponse.json({ error: "no active session" }, { status: 401 });
    const llmProvider: Settings["llmProvider"] =
      body.llmProvider === "openai-compatible" || body.llmProvider === "anthropic" ||
      body.llmProvider === "claude-cli" || body.llmProvider === "codex-cli"
        ? body.llmProvider : (u.llmProvider as Settings["llmProvider"]);
    const themeMode: Settings["themeMode"] =
      body.themeMode === "light" || body.themeMode === "dark" || body.themeMode === "system"
        ? body.themeMode : (u.themeMode as Settings["themeMode"]);
    const mergedKey = body.bugzillaApiKey?.trim() || u.bugzillaApiKey;
    const mergedLlmKey = body.anthropicApiKey?.trim() || u.llmApiKey;
    const mergedBaseUrl = (body.llmBaseUrl ?? u.llmBaseUrl).trim().replace(/\/$/, "");
    const mergedModel = (body.defaultModel ?? u.defaultModel).trim() || u.defaultModel;

    upsertUser({
      email: u.email,
      bugzillaApiKey: mergedKey,
      llmProvider, llmBaseUrl: mergedBaseUrl, llmApiKey: mergedLlmKey,
      defaultModel: mergedModel,
      useCompanyLlm: u.useCompanyLlm,
      themeMode,
    });
    bumpServerCacheVersion(); // key/LLM may have changed → drop cached whoami/products/stats

    // Build the response view from the saved values + server-global URL —
    // getEffectiveSettings() here would read the now-stale request-scoped user.
    const saved: Settings = {
      bugzillaUrl: (process.env.BUGZILLA_URL || "").replace(/\/$/, ""),
      bugzillaInsecure: (process.env.BUGZILLA_INSECURE || "").toLowerCase() === "true",
      bugzillaLogin: u.email,
      bugzillaApiKey: mergedKey,
      llmProvider, llmBaseUrl: mergedBaseUrl, anthropicApiKey: mergedLlmKey,
      defaultModel: mergedModel, themeMode,
      corpusManifestUrl: "", corpusVersion: "", corpusAutoUpdate: false,
    };
    return NextResponse.json({
      ...settingsForUi(saved),
      configured: isBugzillaConfigured(saved),
      multiUser: true,
      saved: true,
    });
  }

  const current = loadSettings();
  const llmProvider: Settings["llmProvider"] =
    body.llmProvider === "openai-compatible" ||
    body.llmProvider === "anthropic" ||
    body.llmProvider === "claude-cli" ||
    body.llmProvider === "codex-cli"
      ? body.llmProvider
      : current.llmProvider;
  const themeMode: Settings["themeMode"] =
    body.themeMode === "light" || body.themeMode === "dark" || body.themeMode === "system"
      ? body.themeMode
      : current.themeMode;
  const next: Settings = {
    bugzillaUrl: (body.bugzillaUrl ?? current.bugzillaUrl).trim().replace(/\/$/, ""),
    bugzillaApiKey: body.bugzillaApiKey?.trim() || current.bugzillaApiKey,
    bugzillaInsecure: typeof body.bugzillaInsecure === "boolean"
      ? body.bugzillaInsecure
      : current.bugzillaInsecure,
    bugzillaLogin: (body.bugzillaLogin ?? current.bugzillaLogin).trim(),
    llmProvider,
    llmBaseUrl: (body.llmBaseUrl ?? current.llmBaseUrl).trim().replace(/\/$/, ""),
    anthropicApiKey: body.anthropicApiKey?.trim() || current.anthropicApiKey,
    defaultModel: (body.defaultModel ?? current.defaultModel).trim() || "claude-opus-4-8",
    themeMode,
    // Corpus fields. corpusManifestUrl may be intentionally edited by China
    // users to a SharePoint mirror; trim/normalize but otherwise pass through.
    // corpusVersion is internal — only the download flow writes to it;
    // accept whatever the UI sends (typically "" via the omitted field).
    corpusManifestUrl: (body.corpusManifestUrl ?? current.corpusManifestUrl).trim(),
    corpusVersion: (body.corpusVersion ?? current.corpusVersion).trim(),
    corpusAutoUpdate: typeof body.corpusAutoUpdate === "boolean"
      ? body.corpusAutoUpdate
      : current.corpusAutoUpdate,
  };

  const errors = validateSettings(next);
  if (errors.length) {
    return NextResponse.json({ errors }, { status: 400 });
  }

  try {
    saveSettings(next);
    // Drop cached whoami/products/stats — the Bugzilla URL/key may have
    // changed, so anything cached from the previous connection is stale.
    bumpServerCacheVersion();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `failed to save: ${msg}` }, { status: 500 });
  }

  return NextResponse.json({
    ...settingsForUi(next),
    configured: isBugzillaConfigured(next),
    saved: true,
  });
});
