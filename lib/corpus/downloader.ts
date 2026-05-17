// ─────────────────────────────────────────────────────────────────
// lib/corpus/downloader.ts — fetch corpus.sqlite.gz, verify sha256,
// decompress, atomically replace the live file.
//
// Flow:
//   1. POST /api/corpus/download asks for a corpus URL (typically the
//      one from the latest manifest fetch).
//   2. We stream the URL to <userData>/corpus/corpus.sqlite.partial.gz
//      using node:https + Node streams (no buffering of the full 10MB
//      in memory).
//   3. After EOF, sha256 the partial file and compare to the manifest's
//      claimed digest.
//   4. Gunzip the partial into corpus.sqlite.partial (still .partial
//      until the rename succeeds — atomic install).
//   5. closeCorpusDb() releases any open handle, then fs.renameSync
//      replaces corpus.sqlite. The next getCorpusDb() reopens.
//   6. Manifest sidecar is written so the next process boot knows what
//      version is installed.
//
// Concurrency: a module-level `_state` variable acts as the live
// progress mailbox polled by /api/corpus/status. Only one download is
// allowed at a time — POST /api/corpus/download returns 409 if a
// download is already in flight.
// ─────────────────────────────────────────────────────────────────

import "server-only";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as https from "node:https";
import * as http from "node:http";
import * as crypto from "node:crypto";
import * as zlib from "node:zlib";

import { appDataDir } from "../settings";
import { closeCorpusDb, corpusPath } from "./store";
import { writeLocalManifest, type CorpusManifest } from "./manifest";

export interface DownloadProgress {
  status: "idle" | "downloading" | "verifying" | "decompressing" | "installing" | "ready" | "error";
  /** Total bytes expected — taken from manifest (sizeBytesGzipped). */
  totalBytes: number;
  /** Bytes received so far during streaming. */
  downloadedBytes: number;
  /** The tag we're installing (e.g. "rel17-v1"). */
  tag?: string;
  /** Human-readable error when status === "error". */
  error?: string;
  /** When the download finished (ms epoch); helps the UI hide stale errors. */
  endedAt?: number;
}

let _state: DownloadProgress = { status: "idle", totalBytes: 0, downloadedBytes: 0 };

export function getDownloadProgress(): DownloadProgress {
  return { ..._state };
}

const corpusDir = () => path.join(appDataDir(), "corpus");
const partialGzPath = () => path.join(corpusDir(), "corpus.sqlite.partial.gz");
const partialSqlitePath = () => path.join(corpusDir(), "corpus.sqlite.partial");

/** Kick off a download. Idempotent — returns immediately if one is
 *  already running. Throws when manifest fields are missing/invalid. */
export async function downloadCorpus(manifest: CorpusManifest, opts: { timeoutMs?: number } = {}): Promise<void> {
  if (_state.status === "downloading" || _state.status === "verifying" || _state.status === "decompressing" || _state.status === "installing") {
    throw new Error("a corpus download is already in progress");
  }
  if (!manifest.artifact?.url || !manifest.artifact?.sha256 || !manifest.artifact?.sizeBytesGzipped) {
    throw new Error("manifest is missing required artifact fields");
  }
  await fsp.mkdir(corpusDir(), { recursive: true });

  _state = {
    status: "downloading",
    totalBytes: manifest.artifact.sizeBytesGzipped,
    downloadedBytes: 0,
    tag: manifest.tag,
  };

  try {
    await streamToFile(manifest.artifact.url, partialGzPath(),
      bytes => { _state.downloadedBytes = bytes; },
      opts.timeoutMs ?? 10 * 60_000);

    _state.status = "verifying";
    const sha = await sha256File(partialGzPath());
    if (sha !== manifest.artifact.sha256) {
      await safeUnlink(partialGzPath());
      throw new Error(`sha256 mismatch: got ${sha.slice(0, 16)}…, expected ${manifest.artifact.sha256.slice(0, 16)}…`);
    }

    _state.status = "decompressing";
    await gunzipFile(partialGzPath(), partialSqlitePath());
    await safeUnlink(partialGzPath());

    _state.status = "installing";
    // Close any open handle so the rename can replace the file on Windows.
    closeCorpusDb();
    fs.renameSync(partialSqlitePath(), corpusPath());
    await writeLocalManifest(manifest);

    _state = {
      status: "ready",
      totalBytes: manifest.artifact.sizeBytesGzipped,
      downloadedBytes: manifest.artifact.sizeBytesGzipped,
      tag: manifest.tag,
      endedAt: Date.now(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeUnlink(partialGzPath());
    await safeUnlink(partialSqlitePath());
    _state = {
      status: "error",
      totalBytes: manifest.artifact.sizeBytesGzipped,
      downloadedBytes: _state.downloadedBytes,
      tag: manifest.tag,
      error: msg,
      endedAt: Date.now(),
    };
    throw err;
  }
}

// ── HTTP streaming with redirect follow + timeout ────────────────

function streamToFile(url: string, dest: string, onProgress: (bytes: number) => void, timeoutMs: number, redirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    let received = 0;
    let timer: NodeJS.Timeout | null = null;
    const armTimeout = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        req.destroy(new Error(`download stalled for ${timeoutMs}ms`));
      }, timeoutMs);
    };
    const req = mod.request({
      method: "GET",
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      headers: { "User-Agent": "bugzilla-triage-desktop/0.1.6 corpus-download" },
    }, res => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
        res.resume();
        if (timer) clearTimeout(timer);
        const next = new URL(res.headers.location, url).toString();
        streamToFile(next, dest, onProgress, timeoutMs, redirects - 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        if (timer) clearTimeout(timer);
        return reject(new Error(`HTTP ${status} from ${url}`));
      }
      const out = fs.createWriteStream(dest);
      res.on("data", chunk => {
        received += chunk.length;
        onProgress(received);
        armTimeout();
      });
      res.pipe(out);
      out.on("finish", () => {
        if (timer) clearTimeout(timer);
        out.close(err => err ? reject(err) : resolve());
      });
      out.on("error", err => { if (timer) clearTimeout(timer); reject(err); });
      armTimeout();
    });
    req.on("error", err => { if (timer) clearTimeout(timer); reject(err); });
    req.end();
  });
}

function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(p)
      .on("data", c => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

function gunzipFile(src: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const inStream = fs.createReadStream(src);
    const outStream = fs.createWriteStream(dest);
    const gz = zlib.createGunzip();
    inStream.on("error", reject);
    outStream.on("error", reject);
    gz.on("error", reject);
    inStream.pipe(gz).pipe(outStream).on("finish", () => resolve());
  });
}

async function safeUnlink(p: string): Promise<void> {
  try { await fsp.unlink(p); } catch { /* ENOENT is fine */ }
}
