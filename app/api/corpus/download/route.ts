import { NextResponse } from "next/server";
import { fetchRemoteManifest } from "@/lib/corpus/manifest";
import { downloadCorpus, getDownloadProgress } from "@/lib/corpus/downloader";
import { loadSettings, saveSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

// Allow up to 10 minutes for a slow corpus download (40MB over a sluggish
// VPN can take a couple minutes). The endpoint returns 202 once the
// download is kicked off and runs to completion async — the Settings UI
// polls /api/corpus/status to watch progress, so we don't need to keep
// the HTTP request alive for the full duration.
export const maxDuration = 600;

// POST /api/corpus/download — kicks off a corpus download.
//
// Body: { manifestUrl?: string }
//   - If `manifestUrl` is provided, use it (one-off override; useful for
//     testing a SharePoint mirror without persisting the URL).
//   - Otherwise, use settings.corpusManifestUrl (the persistent value).
//
// Response:
//   - 202 Accepted with the initial progress object when a download
//     starts. Subsequent polls go to /api/corpus/status.
//   - 409 Conflict if a download is already running (idempotent retry).
//   - 4xx/5xx on manifest fetch / verification errors.
//
// Side-effects on success: settings.corpusVersion is updated so the
// next process boot remembers which version is installed. We don't wait
// for the download to finish to write this — the downloader updates it
// on the way to "ready" status via writeLocalManifest().
export async function POST(req: Request) {
  const progress = getDownloadProgress();
  const inFlight =
    progress.status === "downloading" ||
    progress.status === "verifying" ||
    progress.status === "decompressing" ||
    progress.status === "installing";
  if (inFlight) {
    return NextResponse.json(
      { error: "a corpus download is already in progress", progress },
      { status: 409 },
    );
  }

  let body: { manifestUrl?: string };
  try {
    body = await req.json().catch(() => ({}));
  } catch {
    body = {};
  }

  const settings = loadSettings();
  const manifestUrl = body.manifestUrl?.trim() || settings.corpusManifestUrl;
  if (!manifestUrl) {
    return NextResponse.json(
      { error: "no manifest URL configured (open Settings → Spec corpus → Manifest URL)" },
      { status: 400 },
    );
  }

  // Step 1: fetch the manifest (synchronous wrt the HTTP response so the
  // user sees clear errors here rather than a confusing "download failed"
  // halfway through).
  let manifest;
  try {
    manifest = await fetchRemoteManifest(manifestUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `failed to fetch manifest from ${manifestUrl}: ${msg}` },
      { status: 502 },
    );
  }

  // Step 2: start the download — but DON'T await it. We respond 202
  // with the initial progress; the long-running streaming happens after
  // the HTTP response is sent and is observable via /api/corpus/status.
  // `void` makes the floating-promise lint happy.
  void downloadCorpus(manifest).then(
    () => {
      // Persist the installed version so the next process boot knows.
      const fresh = loadSettings();
      saveSettings({ ...fresh, corpusVersion: manifest.tag });
    },
    err => {
      // Errors are already captured in the downloader's progress state —
      // log here for server-side debugging.
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[corpus] background download failed: ${msg}`);
    },
  );

  return NextResponse.json(
    {
      started: true,
      manifest: {
        tag: manifest.tag,
        release: manifest.release,
        sizeBytesGzipped: manifest.artifact.sizeBytesGzipped,
        sizeBytesUncompressed: manifest.artifact.sizeBytesUncompressed,
      },
      progress: getDownloadProgress(),
    },
    { status: 202 },
  );
}
