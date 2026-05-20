import { NextResponse } from "next/server";
import { readLocalManifest, fetchRemoteManifest, isRemoteNewer, type CorpusManifest } from "@/lib/corpus/manifest";
import { getDownloadProgress } from "@/lib/corpus/downloader";
import { getCorpusMeta, corpusEngineError } from "@/lib/corpus/store";
import { loadSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

// GET /api/corpus/status — single source of truth for the Settings UI's
// corpus card and any "corpus available?" gate in the triage panel.
//
// Behavior:
//   - Always returns the local install state synchronously (cheap reads).
//   - When ?checkRemote=1 is passed, ALSO fetches the remote manifest
//     and surfaces "update available". Without that flag, no network
//     call is made — keeps the status poll loop (during a download)
//     fast and offline-safe.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const checkRemote = url.searchParams.get("checkRemote") === "1";

  const localManifest = await readLocalManifest();
  const meta = getCorpusMeta();
  const engineError = corpusEngineError();
  const progress = getDownloadProgress();
  const settings = loadSettings();

  // `installed` now reflects whether the manifest is on disk — i.e. whether
  // a download has completed. Previously we ANDed this with `!!meta`, which
  // meant "installed" silently flipped to false when the native sqlite
  // engine failed to load on a Windows machine — the user saw the
  // download succeed, then watched the Settings card revert to the
  // download CTA with no explanation. The new shape separates the two:
  //
  //   installed:   true  → corpus file is on disk
  //   engineError: null  → native sqlite engine loaded OK; retrieval works
  //   engineError: "..."  → file is there but better-sqlite3 couldn't load
  //                         (usually missing VC++ runtime on Windows). UI
  //                         should surface this so the user has something
  //                         to act on instead of a mysterious blank state.
  const installed = !!localManifest;
  const base = {
    installed,
    engineError,
    version: localManifest?.tag ?? null,
    builtAt: localManifest?.builtAt ?? null,
    sizeBytesUncompressed: localManifest?.artifact.sizeBytesUncompressed ?? null,
    sizeBytesGzipped: localManifest?.artifact.sizeBytesGzipped ?? null,
    schemaVersion: localManifest?.schemaVersion ?? null,
    totalClauses: meta ? Number(meta.totalClauses ?? 0) : 0,
    release: localManifest?.release ?? null,
    manifestUrl: settings.corpusManifestUrl,
    progress,
  };

  if (!checkRemote) {
    return NextResponse.json(base);
  }

  // Remote check — failures are surfaced as a `remoteError` field rather
  // than a non-200 response. The UI keeps the install info visible even
  // when the manifest URL is unreachable (e.g. user behind a firewall).
  let remote: CorpusManifest | null = null;
  let remoteError: string | null = null;
  try {
    remote = await fetchRemoteManifest(settings.corpusManifestUrl);
  } catch (err) {
    remoteError = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json({
    ...base,
    remote: remote && {
      tag: remote.tag,
      builtAt: remote.builtAt,
      release: remote.release,
      sizeBytesUncompressed: remote.artifact.sizeBytesUncompressed,
      sizeBytesGzipped: remote.artifact.sizeBytesGzipped,
      sha256: remote.artifact.sha256,
      filename: remote.artifact.filename,
    },
    remoteError,
    updateAvailable: remote ? isRemoteNewer(localManifest, remote) : false,
  });
}
