"use client";

// ──────────────────────────────────────────────────────────────────
// CorpusInstallBanner — top-of-page banner that surfaces the optional
// 3GPP RAG corpus download to first-launch users.
//
// Why this exists: the corpus download UI lives in Settings → Spec
// corpus, but new users installing the release .exe / .dmg / .AppImage
// have no obvious nudge to go there. Triage works perfectly without
// the corpus (the model paraphrases from training data), so they may
// never notice they're on the fallback path and missing the lift.
//
// Behaviour:
//   - Polls /api/corpus/status once on mount.
//   - Hidden when: corpus is already installed, OR user dismissed via
//     "Maybe later" (persisted in localStorage so a refresh doesn't
//     re-pester), OR status fetch failed (graceful degrade).
//   - Visible otherwise with a "Download corpus" CTA. The download is
//     triggered via POST /api/corpus/download with no body, so the
//     server falls back to settings.corpusManifestUrl (the default
//     points at the GitHub Releases manifest of the corpus repo;
//     users on a GitHub-blocked network override via Settings).
//   - During download, the banner stays visible and shows live
//     progress %, polled every 500ms while active.
//   - On completion (`installed: true`), the banner auto-hides on
//     the next poll.
//
// The "Maybe later" dismiss does NOT permanently disable the feature
// — users can still go to Settings to download. To re-show the
// banner after dismissing, clear localStorage["corpusBannerDismissed"]
// or simply remove the file (it auto-resets on next install).
// ──────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, Download, X, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";

type ProgressStatus = "idle" | "downloading" | "verifying" | "decompressing" | "installing" | "ready" | "error";

interface CorpusStatus {
  installed: boolean;
  version: string | null;
  totalClauses: number;
  sizeBytesGzipped: number | null;
  progress: {
    status: ProgressStatus;
    totalBytes: number;
    downloadedBytes: number;
    error?: string;
  };
}

const DISMISS_KEY = "corpusBannerDismissed";

const fmtMB = (n: number | null | undefined): string =>
  n == null ? "?" : `${(n / 1024 / 1024).toFixed(0)} MB`;

export function CorpusInstallBanner() {
  const [status, setStatus] = useState<CorpusStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Restore dismissed flag from localStorage. Done in an effect (not
  // initial state) because localStorage isn't available during SSR.
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
    } catch { /* private mode or storage quota — treat as not dismissed */ }
  }, []);

  // Poll status. Fast cadence while a download is active; slow once idle.
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
        const fast = ["downloading", "verifying", "decompressing", "installing"].includes(data.progress.status);
        timer = setTimeout(tick, fast ? 500 : 10_000);
      } catch {
        // Network blip; back off and try again.
        if (active) timer = setTimeout(tick, 10_000);
      }
    };
    tick();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const onDownload = useCallback(async () => {
    setDownloadError(null);
    try {
      const r = await fetch("/api/corpus/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",   // server falls back to settings.corpusManifestUrl
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      // Poll loop above will pick up progress and re-render.
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const onDismiss = useCallback(() => {
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore */ }
    setDismissed(true);
  }, []);

  // Hide entirely once installed, regardless of dismiss state — the
  // banner has done its job. (Settings page still shows the version /
  // update controls.)
  if (status?.installed) return null;
  // Hide before we've heard from the server — avoids flashing the
  // banner on every page load.
  if (!status) return null;
  // Respect the user's dismissal unless a download is currently
  // running (in which case the user should see progress).
  const phase = status.progress.status;
  const isActive = phase === "downloading" || phase === "verifying" || phase === "decompressing" || phase === "installing";
  if (dismissed && !isActive) return null;

  // Active download — show inline progress.
  if (isActive) {
    const pct = status.progress.totalBytes > 0
      ? Math.round((status.progress.downloadedBytes / status.progress.totalBytes) * 100)
      : 0;
    return (
      <div className="card border-accent/30 bg-accent/5 px-4 py-3 mb-4 flex items-center gap-3 animate-fade-in">
        <Loader2 className="w-4 h-4 text-accent animate-spin shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs text-slate-200 font-medium">
            Installing 3GPP corpus… <span className="text-slate-400 font-mono">{phase}</span> {pct > 0 && <span className="text-slate-500">{pct}%</span>}
          </div>
          {status.progress.totalBytes > 0 && (
            <div className="mt-1.5 h-1 rounded bg-bg-border/40 overflow-hidden">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  // Failed/errored — show error with Retry + Dismiss.
  if (phase === "error") {
    return (
      <div className="card border-red-500/30 bg-red-950/20 px-4 py-3 mb-4 flex items-start gap-3 animate-fade-in">
        <AlertCircle className="w-4 h-4 text-red-300 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-xs text-slate-200 font-medium">3GPP corpus download failed</div>
          <div className="text-[11px] text-slate-400 mt-0.5 break-words">
            {status.progress.error || downloadError || "unknown error"}
          </div>
        </div>
        <button onClick={onDownload} className="btn-secondary text-xs">Retry</button>
        <button onClick={onDismiss} className="btn-ghost p-1" aria-label="Dismiss">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  // Default: idle + not installed + not dismissed → the CTA.
  return (
    <div className="card border-accent/30 bg-accent/5 px-4 py-3 mb-4 flex items-start gap-3 animate-fade-in">
      <div className="w-7 h-7 rounded-md bg-gradient-to-br from-accent to-fuchsia-600 flex items-center justify-center shrink-0">
        <BookOpen className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-slate-100 font-medium flex items-center gap-1.5">
          <CheckCircle2 className="w-3 h-3 text-emerald-400" /> Tip: install the 3GPP RAG corpus
          <span className="text-[10px] font-mono font-normal text-slate-500 bg-bg-hover/60 ring-1 ring-bg-border/50 px-1.5 py-px rounded">
            ~{fmtMB(status.sizeBytesGzipped) === "? MB" ? "10 MB" : fmtMB(status.sizeBytesGzipped)}
          </span>
        </div>
        <div className="text-[11px] text-slate-400 mt-1 leading-snug">
          AI triage cites real Rel-17 NR + LTE spec excerpts instead of training-data paraphrase. One-time download. You can install / manage / replace it any time from{" "}
          <Link href="/settings" className="text-accent-glow hover:underline">Settings → Spec corpus</Link>.
        </div>
        {downloadError && (
          <div className="text-[11px] text-red-300 mt-1.5 flex items-center gap-1">
            <AlertCircle className="w-3 h-3" /> {downloadError}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button onClick={onDownload} className="btn-primary text-xs flex items-center gap-1">
          <Download className="w-3 h-3" />
          Download corpus
        </button>
        <button onClick={onDismiss} className="btn-ghost p-1" title="Maybe later" aria-label="Dismiss">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
