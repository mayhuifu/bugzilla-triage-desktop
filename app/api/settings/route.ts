import { NextRequest, NextResponse } from "next/server";
import {
  loadSettings, saveSettings, validateSettings, settingsForUi,
  isBugzillaConfigured, type Settings,
} from "@/lib/settings";
import { bumpServerCacheVersion } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

// GET — return the settings the UI should display. Secrets are stripped
// here: the page never sees the raw Bugzilla or Anthropic API keys, only
// a `hasFooKey` boolean for the "(saved)" indicator next to the input.
export async function GET() {
  const settings = loadSettings();
  return NextResponse.json({
    ...settingsForUi(settings),
    configured: isBugzillaConfigured(settings),
  });
}

// POST — validate + persist. The page sends every editable field every
// time. Secrets are handled with a sentinel: the page sends "" if the user
// didn't touch the field, and we keep the prior stored value in that
// case. That lets a user save a URL change without re-typing their API key.
export async function POST(req: NextRequest) {
  let body: Partial<Settings>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
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
    defaultModel: (body.defaultModel ?? current.defaultModel).trim() || "claude-opus-4-7",
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
}
