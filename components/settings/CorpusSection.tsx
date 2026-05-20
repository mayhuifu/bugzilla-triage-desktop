"use client";

// ──────────────────────────────────────────────────────────────────
// CorpusSection — Settings page card that exposes the 3GPP RAG
// corpus state to the user.
//
// Three modes:
//
//   1. Not installed → "Download corpus (10 MB · adds real 3GPP spec
//      excerpts to AI triage)" call-to-action button. Optional.
//
//   2. Downloading → live progress bar polled from
//      /api/corpus/status every 500ms.
//
//   3. Installed → version chip, total clauses, last-updated timestamp,
//      "Check for updates" button. The manifest URL input is always
//      visible and editable — China-blocked-GitHub users override it
//      to a SharePoint mirror here. The change is staged locally and
//      applied on the parent Settings page's Save button (consistent
//      with the rest of the page's commit pattern).
//
// Errors during download are surfaced inline with a "Retry" affordance.
// The component never blocks the rest of the Settings page; triage
// works perfectly well with the corpus uninstalled (the model paraphrase
// from v0.1.5 is the fallback).
// ──────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import {
  BookOpen, Download, RefreshCw, CheckCircle2, AlertCircle, Loader2, Globe, Trash2,
} from "lucide-react";

type ProgressStatus = "idle" | "downloading" | "verifying" | "decompressing" | "installing" | "ready" | "error";

interface CorpusStatus {
  installed: boolean;
  version: string | null;
  builtAt: string | null;
  sizeBytesUncompressed: number | null;
  sizeBytesGzipped: number | null;
  schemaVersion: number | null;
  totalClauses: number;
  release: string | null;
  manifestUrl: string;
  progress: {
    status: ProgressStatus;
    totalBytes: number;
    downloadedBytes: number;
    tag?: string;
    error?: string;
    endedAt?: number;
  };
  // Present only when ?checkRemote=1 was passed.
  remote?: {
    tag: string;
    builtAt: string;
    release: string;
    sizeBytesUncompressed: number;
    sizeBytesGzipped: number;
    sha256: string;
    filename: string;
  } | null;
  remoteError?: string | null;
  updateAvailable?: boolean;
}

interface Props {
  /** Manifest URL bound to the parent Settings page's local form state.
   *  Edits flow up so the parent's Save button persists the change with
   *  the rest of the settings; this section never POSTs by itself. */
  manifestUrl: string;
  onManifestUrlChange: (v: string) => void;
}

const fmtBytes = (n: number | null | undefined): string =>
  n == null ? "?" : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;

const fmtPercent = (done: number, total: number) =>
  total > 0 ? `${Math.round((done / total) * 100)}%` : "0%";

export function CorpusSection({ manifestUrl, onManifestUrlChange }: Props) {
  const [status, setStatus] = useState<CorpusStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  // Initial fetch + polling. Poll cadence:
  //   - downloading/verifying/decompressing/installing → every 500ms
  //   - everything else → every 5s (cheap, no network, just reads the
  //     local mailbox so the UI reflects external state changes too)
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const r = await fetch("/api/corpus/status");
        if (!r.ok || !active) return;
        const data = (await r.json()) as CorpusStatus;
        if (!active) return;
        setStatus(data);
        const phase = data.progress.status;
        const fast = phase === "downloading" || phase === "verifying" ||
                     phase === "decompressing" || phase === "installing";
        timer = setTimeout(tick, fast ? 500 : 5000);
      } catch {
        // Network blip — retry slowly so we don't spam logs.
        if (active) timer = setTimeout(tick, 5000);
      }
    };
    tick();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const onDownload = useCallback(async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      // Send the (possibly-edited) manifest URL so users can preview
      // a SharePoint mirror without saving the settings first.
      const r = await fetch("/api/corpus/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifestUrl }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      // Poll loop above will pick up the progress.
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }, [manifestUrl]);

  const onCheckUpdate = useCallback(async () => {
    setCheckingUpdate(true);
    try {
      const r = await fetch("/api/corpus/status?checkRemote=1");
      if (r.ok) setStatus((await r.json()) as CorpusStatus);
    } finally {
      setCheckingUpdate(false);
    }
  }, []);

  const phase = status?.progress.status ?? "idle";
  const isActive = phase === "downloading" || phase === "verifying" || phase === "decompressing" || phase === "installing";

  return (
    <section className="card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <BookOpen className="w-4 h-4 text-accent" />
        <h2 className="text-sm font-medium text-slate-200">3GPP spec corpus (optional)</h2>
        {status?.installed && (
          <span className="badge text-[10px] bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/30 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> {status.version}
          </span>
        )}
        {status?.updateAvailable && (
          <span className="badge text-[10px] bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/30">
            update available
          </span>
        )}
      </div>
      <p className="text-xs text-slate-500">
        When installed, AI triage cites <em>real</em> spec text from a local Rel-17 NR + LTE
        corpus (5,667 leaf clauses + 9,920 tables · ~80 MB, ~26 MB compressed download)
        instead of the model&apos;s training-data paraphrase. Triage works fine without it —
        you can install at any time.
      </p>

      {/* Installed-state info */}
      {status?.installed && (
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <Stat label="Version">{status.version}</Stat>
          <Stat label="Clauses">{status.totalClauses.toLocaleString()}</Stat>
          <Stat label="Size">{fmtBytes(status.sizeBytesUncompressed)}</Stat>
        </div>
      )}

      {/* Manifest URL — always editable. China-blocked-GitHub users put a
          SharePoint URL here. */}
      <div className="space-y-1">
        <div className="flex items-baseline justify-between">
          <label className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
            <Globe className="w-3 h-3" />
            Manifest URL
          </label>
          <span className="text-[10px] text-slate-500">
            Override for internal mirror (e.g. SharePoint)
          </span>
        </div>
        <input
          type="url"
          className="input text-xs font-mono"
          value={manifestUrl}
          onChange={e => onManifestUrlChange(e.target.value)}
          placeholder="https://github.com/.../manifest.json"
          spellCheck={false}
        />
        <div className="text-[10px] text-slate-500">
          The desktop app fetches this URL first, then downloads the artifact from the
          <code className="font-mono mx-1">artifact.url</code> field inside the manifest —
          so a single override redirects both the manifest and the corpus to your internal mirror.
        </div>
      </div>

      {/* Progress bar while a download is in flight */}
      {isActive && status && (
        <div className="space-y-2 bg-bg-panel/40 rounded-md p-3 border border-bg-border/40">
          <div className="flex items-center gap-2 text-xs text-slate-200">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
            <span className="capitalize">{phase}</span>
            <span className="text-slate-500 ml-auto">
              {fmtBytes(status.progress.downloadedBytes)} / {fmtBytes(status.progress.totalBytes)} ·{" "}
              {fmtPercent(status.progress.downloadedBytes, status.progress.totalBytes)}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-bg-hover overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-accent to-fuchsia-500 transition-all duration-300"
              style={{
                width: `${Math.min(100, status.progress.totalBytes > 0
                  ? (status.progress.downloadedBytes / status.progress.totalBytes) * 100
                  : 0)}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Error from the most recent download attempt */}
      {(downloadError || (phase === "error" && status?.progress.error)) && (
        <div className="card border-red-500/30 bg-red-950/20 p-3 text-xs text-red-300 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Download failed</div>
            <div className="text-slate-400 mt-1 break-all">
              {downloadError || status?.progress.error}
            </div>
          </div>
        </div>
      )}

      {/* Remote-check error (when "Check for updates" was clicked) */}
      {status?.remoteError && (
        <div className="card border-amber-500/30 bg-amber-950/10 p-3 text-xs text-amber-300 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div className="break-all">
            Couldn&apos;t reach the manifest URL: {status.remoteError}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {!status?.installed && !isActive && (
          <button
            onClick={onDownload}
            disabled={downloading || !manifestUrl.trim()}
            className="btn-primary text-xs"
          >
            {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            {downloading ? "Starting…" : "Download corpus"}
          </button>
        )}
        {status?.installed && !isActive && (
          <>
            <button
              onClick={onCheckUpdate}
              disabled={checkingUpdate}
              className="btn-secondary text-xs"
              title="Fetch the manifest URL and compare against the installed version"
            >
              {checkingUpdate
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <RefreshCw className="w-3.5 h-3.5" />}
              Check for updates
            </button>
            {status.updateAvailable && (
              <button
                onClick={onDownload}
                className="btn-primary text-xs"
                title={`Replace ${status.version} with ${status.remote?.tag ?? "the newer version"}`}
              >
                <Download className="w-3.5 h-3.5" />
                Update to {status.remote?.tag}
              </button>
            )}
          </>
        )}
        {status?.installed && (
          <span className="text-[10px] text-slate-500 ml-auto">
            stored at <code className="font-mono">{"<userData>/corpus/corpus.sqlite"}</code>
          </span>
        )}
      </div>
    </section>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-panel/40 rounded-md p-2 border border-bg-border/40">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">
        {label}
      </div>
      <div className="text-sm text-slate-100 font-mono mt-0.5 truncate">{children}</div>
    </div>
  );
}

// Trash2 import kept above for completeness — placeholder for a future
// "Remove corpus" button. Not exposed in v0.1.7; users can just delete
// the SQLite from the data dir or re-download.
void Trash2;
