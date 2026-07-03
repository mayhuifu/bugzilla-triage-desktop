// ─────────────────────────────────────────────────────────────────
// lib/corpus/embedder-stage.ts — BACKGROUND staging of the query
// embedder's ONNX files into <appData>/models/<repo>/.
//
// Why this exists: letting Transformers.js download the model inline
// (its default) puts a ~570 MB fetch INSIDE the first search request —
// the query blocks for minutes, and on networks that reset long
// connections (github/HF from CN) the download dies mid-stream with no
// resume, restarts on the next search, and effectively never finishes:
// the app looks hung. (Observed on the Windows desktop after the
// rel17-v7 corpus update.)
//
// The fix is to decouple acquisition from querying:
//   - the embedder (embedder-bge.ts) NEVER downloads — it loads staged
//     files or fails instantly, so searches always return (keyword-only
//     until the model is ready);
//   - this module downloads the files in the background with HTTP Range
//     RESUME (a reset continues instead of restarting) and exposes
//     progress for /api/corpus/status.
//
// Same host/override contract as install-corpus.mjs and
// fetch-embed-model.mjs: HF_ENDPOINT env, hf-mirror.com default.
// ─────────────────────────────────────────────────────────────────

import "server-only";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as https from "node:https";
import * as http from "node:http";
import { appDataDir } from "../paths";

export interface EmbedderStageState {
  status: "idle" | "staging" | "ready" | "error";
  repo?: string;
  /** File currently downloading (repo-relative). */
  file?: string;
  receivedBytes?: number;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

let _state: EmbedderStageState = { status: "idle" };
let _inFlight: Promise<void> | null = null;

export function getEmbedderStageState(): EmbedderStageState {
  return { ..._state };
}

const hfEndpoint = () =>
  (process.env.HF_ENDPOINT || "https://hf-mirror.com").replace(/\/+$/, "");

function onnxFileFor(dtype: string): string {
  return dtype === "fp32" ? "onnx/model.onnx"
    : dtype === "fp16" ? "onnx/model_fp16.onnx"
    : "onnx/model_quantized.onnx";
}

/** Repo-relative files that make a staged model loadable. */
function requiredFiles(dtype: string): string[] {
  return ["config.json", "tokenizer.json", "tokenizer_config.json", onnxFileFor(dtype)];
}
const OPTIONAL_FILES = ["special_tokens_map.json"];

export function stagedModelDir(repo: string): string {
  return path.join(appDataDir(), "models", ...repo.split("/"));
}

/** True when every required file is present (ONNX ≥ 1 MB — a partial
 *  download parks under a .partial suffix so presence means complete). */
export function isModelStaged(repo: string, dtype: string): boolean {
  const dir = stagedModelDir(repo);
  try {
    for (const f of requiredFiles(dtype)) {
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) return false;
      if (f.startsWith("onnx/") && fs.statSync(p).size < 1_000_000) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Kick background staging for `repo` (idempotent — one in-flight run per
 *  process; re-kick after a failed run RESUMES the partial download).
 *  Never throws; never blocks the caller. */
export function ensureEmbedderStaging(repo: string, dtype: string): void {
  if (_inFlight) return;
  if (isModelStaged(repo, dtype)) {
    _state = { status: "ready", repo, endedAt: Date.now() };
    return;
  }
  _state = { status: "staging", repo, startedAt: Date.now() };
  _inFlight = stage(repo, dtype)
    .then(() => {
      _state = { status: "ready", repo, endedAt: Date.now() };
      // eslint-disable-next-line no-console
      console.info(`[corpus] embedder ${repo} staged — semantic (hybrid) search activates on the next query`);
    })
    .catch(err => {
      _state = {
        status: "error", repo,
        error: err instanceof Error ? err.message : String(err),
        endedAt: Date.now(),
      };
      // eslint-disable-next-line no-console
      console.warn(`[corpus] embedder staging failed (will resume on next retrieval): ${_state.error}`);
    })
    .finally(() => { _inFlight = null; });
}

async function stage(repo: string, dtype: string): Promise<void> {
  const dir = stagedModelDir(repo);
  await fsp.mkdir(path.join(dir, "onnx"), { recursive: true });
  const base = `${hfEndpoint()}/${repo}/resolve/main`;
  // eslint-disable-next-line no-console
  console.info(`[corpus] staging query embedder ${repo} (${dtype}) in the background from ${hfEndpoint()} → ${dir} (searches stay keyword-only until done; downloads resume if interrupted)`);

  for (const f of [...requiredFiles(dtype), ...OPTIONAL_FILES]) {
    const dest = path.join(dir, f);
    if (fs.existsSync(dest) && (!f.startsWith("onnx/") || fs.statSync(dest).size > 1_000_000)) continue;
    const partial = `${dest}.partial`;
    _state = { ..._state, file: f, receivedBytes: fs.existsSync(partial) ? fs.statSync(partial).size : 0 };
    try {
      // Big file: retry loop with Range resume; each attempt CONTINUES.
      const attempts = 8;
      for (let i = 0; ; i++) {
        try {
          await streamToFileResumable(`${base}/${f}`, partial, b => { _state.receivedBytes = b; });
          break;
        } catch (err) {
          if (i >= attempts - 1) throw err;
          await new Promise(r => setTimeout(r, Math.min(15_000, 1000 * 2 ** i) + Math.floor(Math.random() * 500)));
        }
      }
      await fsp.rename(partial, dest);
    } catch (err) {
      if (OPTIONAL_FILES.includes(f)) continue; // tolerate missing optional files
      throw err;
    }
  }
}

// Range-resuming stream-to-file (same shape as lib/corpus/downloader.ts —
// kept local so this module has no coupling to the corpus download state
// machine). 206 → append; 200 → restart; 416 → already complete. Response
// stream errors reject immediately (a mid-stream reset must not sit out
// the stall timeout).
function streamToFileResumable(url: string, dest: string, onProgress: (bytes: number) => void, timeoutMs = 60_000, redirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    let existing = 0;
    try { existing = fs.existsSync(dest) ? fs.statSync(dest).size : 0; } catch { /* 0 */ }
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    let timer: NodeJS.Timeout | null = null;
    const arm = (req: http.ClientRequest) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => req.destroy(new Error(`download stalled ${timeoutMs}ms`)), timeoutMs);
    };
    const headers: Record<string, string> = { "User-Agent": "bugzilla-triage-desktop embedder-stage" };
    if (existing > 0) headers.Range = `bytes=${existing}-`;
    const req = mod.request(
      { method: "GET", hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search, headers },
      res => {
        const s = res.statusCode ?? 0;
        if (s >= 300 && s < 400 && res.headers.location && redirects > 0) {
          res.resume(); if (timer) clearTimeout(timer);
          streamToFileResumable(new URL(res.headers.location, url).toString(), dest, onProgress, timeoutMs, redirects - 1).then(resolve, reject);
          return;
        }
        if (s === 416) { res.resume(); if (timer) clearTimeout(timer); return resolve(); }
        if (s !== 200 && s !== 206) { res.resume(); if (timer) clearTimeout(timer); return reject(new Error(`HTTP ${s} from ${url}`)); }
        const append = s === 206 && existing > 0;
        const out = fs.createWriteStream(dest, append ? { flags: "a" } : {});
        let received = append ? existing : 0;
        res.on("data", c => { received += c.length; onProgress(received); arm(req); });
        res.on("error", e => { if (timer) clearTimeout(timer); reject(e); });
        res.on("aborted", () => { if (timer) clearTimeout(timer); reject(new Error("connection aborted mid-download")); });
        res.pipe(out);
        out.on("finish", () => { if (timer) clearTimeout(timer); out.close(e => (e ? reject(e) : resolve())); });
        out.on("error", e => { if (timer) clearTimeout(timer); reject(e); });
        arm(req);
      },
    );
    req.on("error", e => { if (timer) clearTimeout(timer); reject(e); });
    req.end();
  });
}
