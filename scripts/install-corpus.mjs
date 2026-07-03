#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────
// scripts/install-corpus.mjs — one-time, SERVER-SIDE install of the 3GPP RAG
// corpus into the shared data directory. In multi-user / server mode the corpus
// is a single file that every user reads — there is NO per-user download. An
// admin runs this once after deploying the server:
//
//   docker exec <container> node scripts/install-corpus.mjs
//
//   # Behind the Great Firewall / offline — point at an internal mirror that
//   # hosts the same manifest.json + .sqlite.gz (same layout as the GitHub
//   # release). The manifest's `artifact.url` decides where the .gz is fetched.
//   docker exec -e CORPUS_MANIFEST_URL=https://mirror.internal/3gpp-corpus.manifest.json \
//       <container> node scripts/install-corpus.mjs
//
//   # Replace an already-installed corpus:
//   docker exec <container> node scripts/install-corpus.mjs --force
//
// Idempotent: exits 0 without downloading if the corpus is already present
// (unless --force). Self-contained (node built-ins only) so it runs inside the
// Next.js standalone image, which has node but not the app's TS libs.
//
// The install path mirrors lib/paths.ts → lib/corpus/store.ts exactly:
//   <appDataDir>/corpus/corpus.sqlite
// where appDataDir() honours XDG_CONFIG_HOME (the server image sets it to /data),
// so the file lands at /data/bugzilla-triage-desktop/corpus/corpus.sqlite — on
// the persistent volume, shared by all users.
//
// ── Query embedder (rel17-v7+) ──────────────────────────────────
// Corpora from rel17-v7 are embedded with BAAI/bge-m3; without the matching
// query-side model the app silently degrades to keyword-only retrieval. The
// manifest declares `embeddingModel`, and this script stages the ONNX runtime
// files (~590 MB for bge-m3 q8) into <appDataDir>/models/<repo>/ — also on
// the persistent volume — where the app's embedder looks after the image-
// bundled <cwd>/models/. The big file downloads with HTTP Range RESUME, so
// flaky egress just continues instead of restarting. Idempotent; skipped when
// the model is already present (image bundle or a previous run).
//
//   # override the download host (e.g. huggingface.co or an internal mirror):
//   docker exec -e HF_ENDPOINT=https://huggingface.co <container> node scripts/install-corpus.mjs
//   # corpus only, no embedder staging:
//   docker exec <container> node scripts/install-corpus.mjs --skip-embedder
// ─────────────────────────────────────────────────────────────────

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";
import crypto from "node:crypto";

// Stable alias — GitHub's `releases/latest` redirect always resolves this to
// the NEWEST corpus release (each release uploads its manifest under this
// fixed name too). Re-running with --force therefore upgrades to the latest
// corpus without touching this script.
const DEFAULT_MANIFEST_URL =
  "https://github.com/mayhuifu/bugzilla-triage-corpus/releases/latest/download/corpus-latest.manifest.json";
const APP_DIR_NAME = "bugzilla-triage-desktop";
const FORCE = process.argv.includes("--force");
const SKIP_EMBEDDER = process.argv.includes("--skip-embedder");
const MANIFEST_URL = (process.env.CORPUS_MANIFEST_URL || DEFAULT_MANIFEST_URL).trim();
// Same default + override contract as the app's runtime embedder and
// scripts/fetch-embed-model.mjs (huggingface.co LFS is unreliable from some
// networks; hf-mirror is a drop-in with the same /resolve/ layout).
const HF_ENDPOINT = (process.env.HF_ENDPOINT || "https://hf-mirror.com").replace(/\/+$/, "");

// corpus meta.embeddingModel → the ONNX repo the runtime loads (must mirror
// MODEL_CONFIGS in lib/corpus/embedder-bge.ts).
const EMBEDDER_REPOS = {
  "BAAI/bge-m3": "Xenova/bge-m3",
  "BAAI/bge-small-en-v1.5": "Xenova/bge-small-en-v1.5",
};
// BGE_DTYPE mirrors the runtime's quantisation pick (q8 default).
const EMBED_DTYPE = (process.env.BGE_DTYPE || "q8").toLowerCase();
const ONNX_FILE = EMBED_DTYPE === "fp32" ? "onnx/model.onnx"
  : EMBED_DTYPE === "fp16" ? "onnx/model_fp16.onnx"
  : "onnx/model_quantized.onnx";

// Resolve the app data dir EXACTLY as lib/paths.ts does — keep in sync.
function appDataDir() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), APP_DIR_NAME);
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", APP_DIR_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), APP_DIR_NAME);
}

const corpusDir = path.join(appDataDir(), "corpus");
const corpusFile = path.join(corpusDir, "corpus.sqlite");
const partialGz = path.join(corpusDir, "corpus.sqlite.partial.gz");
const partialDb = path.join(corpusDir, "corpus.sqlite.partial");
const manifestFile = path.join(corpusDir, "manifest.json");

const log = (...a) => console.log("[install-corpus]", ...a);
const fmtMB = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeUnlink = async (p) => { try { await fsp.unlink(p); } catch { /* not there */ } };

// ── HTTP GET a (small) string, following redirects ──
function getString(url, timeoutMs = 20_000, redirects = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      { method: "GET", hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search, headers: { "User-Agent": "bugzilla-triage install-corpus" }, timeout: timeoutMs },
      (res) => {
        const s = res.statusCode ?? 0;
        if (s >= 300 && s < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return getString(new URL(res.headers.location, url).toString(), timeoutMs, redirects - 1).then(resolve, reject);
        }
        if (s < 200 || s >= 300) { res.resume(); return reject(new Error(`HTTP ${s} from ${url}`)); }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.end();
  });
}

// ── Stream a URL to a file, following redirects, with a stall timeout ──
function streamToFile(url, dest, onProgress, timeoutMs = 10 * 60_000, redirects = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    let timer = null;
    const arm = (req) => { if (timer) clearTimeout(timer); timer = setTimeout(() => req.destroy(new Error(`download stalled ${timeoutMs}ms`)), timeoutMs); };
    const req = mod.request(
      { method: "GET", hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search, headers: { "User-Agent": "bugzilla-triage install-corpus" } },
      (res) => {
        const s = res.statusCode ?? 0;
        if (s >= 300 && s < 400 && res.headers.location && redirects > 0) {
          res.resume(); if (timer) clearTimeout(timer);
          return streamToFile(new URL(res.headers.location, url).toString(), dest, onProgress, timeoutMs, redirects - 1).then(resolve, reject);
        }
        if (s < 200 || s >= 300) { res.resume(); if (timer) clearTimeout(timer); return reject(new Error(`HTTP ${s} from ${url}`)); }
        const out = fs.createWriteStream(dest);
        let received = 0;
        res.on("data", (c) => { received += c.length; onProgress(received); arm(req); });
        res.pipe(out);
        out.on("finish", () => { if (timer) clearTimeout(timer); out.close((e) => (e ? reject(e) : resolve())); });
        out.on("error", (e) => { if (timer) clearTimeout(timer); reject(e); });
        arm(req);
      },
    );
    req.on("error", (e) => { if (timer) clearTimeout(timer); reject(e); });
    req.end();
  });
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(p).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

// ── Resumable variant of streamToFile ──────────────────────────────
// Sends `Range: bytes=<partial>-` when a partial file exists and APPENDS on
// a 206 response; a 200 (server ignored the range) restarts from zero. This
// is what makes the ~590 MB embedder download survive proxies that kill
// long-lived connections mid-stream — each retry CONTINUES instead of
// starting over (the plain fetch could loop forever on such networks).
function streamToFileResumable(url, dest, onProgress, timeoutMs = 10 * 60_000, redirects = 5) {
  return new Promise((resolve, reject) => {
    const existing = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    let timer = null;
    const arm = (req) => { if (timer) clearTimeout(timer); timer = setTimeout(() => req.destroy(new Error(`download stalled ${timeoutMs}ms`)), timeoutMs); };
    const headers = { "User-Agent": "bugzilla-triage install-corpus" };
    if (existing > 0) headers.Range = `bytes=${existing}-`;
    const req = mod.request(
      { method: "GET", hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search, headers },
      (res) => {
        const s = res.statusCode ?? 0;
        if (s >= 300 && s < 400 && res.headers.location && redirects > 0) {
          res.resume(); if (timer) clearTimeout(timer);
          return streamToFileResumable(new URL(res.headers.location, url).toString(), dest, onProgress, timeoutMs, redirects - 1).then(resolve, reject);
        }
        if (s === 416) { // range beyond EOF — file already complete
          res.resume(); if (timer) clearTimeout(timer);
          return resolve();
        }
        if (s !== 200 && s !== 206) { res.resume(); if (timer) clearTimeout(timer); return reject(new Error(`HTTP ${s} from ${url}`)); }
        const append = s === 206 && existing > 0;
        const out = fs.createWriteStream(dest, append ? { flags: "a" } : {});
        let received = append ? existing : 0;
        res.on("data", (c) => { received += c.length; onProgress(received); arm(req); });
        res.pipe(out);
        out.on("finish", () => { if (timer) clearTimeout(timer); out.close((e) => (e ? reject(e) : resolve())); });
        out.on("error", (e) => { if (timer) clearTimeout(timer); reject(e); });
        arm(req);
      },
    );
    req.on("error", (e) => { if (timer) clearTimeout(timer); reject(e); });
    req.end();
  });
}

function gunzipFile(src, dest) {
  return new Promise((resolve, reject) => {
    const r = fs.createReadStream(src), g = zlib.createGunzip(), w = fs.createWriteStream(dest);
    r.on("error", reject); g.on("error", reject); w.on("error", reject); w.on("finish", resolve);
    r.pipe(g).pipe(w);
  });
}

// Retry transient network failures (mirrors fetch scripts' resilience).
async function withRetry(label, fn, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      if (i === attempts - 1) throw err;
      const wait = Math.min(30_000, 1000 * 2 ** i);
      log(`${label} failed (${err.message}) — retry ${i + 1}/${attempts - 1} in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
}

// ── Query-embedder staging (rel17-v7+) ────────────────────────────
// Reads which model the corpus was EMBEDDED with (manifest.embeddingModel;
// falls back to the locally installed manifest for corpora installed before
// the field existed) and stages the matching ONNX repo into
// <appDataDir>/models/<repo>/ unless it's already available there or in the
// image-bundled <cwd>/models/. Idempotent: presence of config.json + the
// ONNX file (≥ 1 MB) means "staged".
async function stageEmbedder(manifest) {
  if (SKIP_EMBEDDER) { log("embedder staging skipped (--skip-embedder)"); return; }
  let model = manifest?.embeddingModel;
  if (!model && fs.existsSync(manifestFile)) {
    try { model = JSON.parse(fs.readFileSync(manifestFile, "utf8")).embeddingModel; } catch { /* ignore */ }
  }
  if (!model) {
    log("manifest declares no embeddingModel — skipping embedder staging");
    log("(pre-v7 corpora use the image-bundled bge-small; nothing to do)");
    return;
  }
  const repo = EMBEDDER_REPOS[model];
  if (!repo) {
    log(`! corpus embeddingModel '${model}' has no known ONNX repo — semantic search will be OFF (keyword-only).`);
    log("  Update the app to a version that supports this model.");
    return;
  }

  const staged = (root) => {
    const cfg = path.join(root, ...repo.split("/"), "config.json");
    const onnx = path.join(root, ...repo.split("/"), ONNX_FILE);
    return fs.existsSync(cfg) && fs.existsSync(onnx) && fs.statSync(onnx).size > 1_000_000;
  };
  const cwdModels = path.join(process.cwd(), "models");      // image-bundled
  const dataModels = path.join(appDataDir(), "models");      // persistent volume
  if (staged(cwdModels)) { log(`embedder ${repo} already bundled in the image (${cwdModels}) — OK`); return; }
  if (staged(dataModels)) { log(`embedder ${repo} already staged (${dataModels}) — OK`); return; }

  const destRoot = path.join(dataModels, ...repo.split("/"));
  await fsp.mkdir(path.join(destRoot, "onnx"), { recursive: true });
  const base = `${HF_ENDPOINT}/${repo}/resolve/main`;
  log(`staging query embedder ${repo} (${EMBED_DTYPE}) from ${HF_ENDPOINT} → ${destRoot}`);
  log("(bge-m3 q8 is ~590 MB total — one-time; the download RESUMES if interrupted)");

  const SMALL = ["config.json", "tokenizer.json", "tokenizer_config.json"];
  const OPTIONAL = ["special_tokens_map.json"];
  for (const f of [...SMALL, ...OPTIONAL]) {
    const dest = path.join(destRoot, f);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
    try {
      await withRetry(f, async () => {
        let last = 0;
        await streamToFileResumable(`${base}/${f}`, dest, (b) => {
          if (b - last > 4 * 1024 * 1024) { last = b; process.stdout.write(`  ${f}: ${fmtMB(b)}\r`); }
        });
      });
      log(`  ${f}: ${fmtMB(fs.statSync(dest).size)}`);
    } catch (err) {
      if (OPTIONAL.includes(f)) { log(`  ${f}: skipped (${err.message})`); await safeUnlink(dest); }
      else throw err;
    }
  }
  const onnxDest = path.join(destRoot, ONNX_FILE);
  await withRetry(ONNX_FILE, async () => {
    let last = 0;
    await streamToFileResumable(`${base}/${ONNX_FILE}`, onnxDest, (b) => {
      if (b - last > 16 * 1024 * 1024) { last = b; process.stdout.write(`  ${ONNX_FILE}: ${fmtMB(b)}\r`); }
    });
  }, 8);
  process.stdout.write("\n");
  log(`✓ embedder staged → ${onnxDest} (${fmtMB(fs.statSync(onnxDest).size)})`);
}

async function main() {
  let manifest = null;

  if (fs.existsSync(corpusFile) && !FORCE) {
    log(`corpus already installed → ${corpusFile} (${fmtMB(fs.statSync(corpusFile).size)})`);
    log("Re-run with --force to replace it with the newest release.");
  } else {
    await fsp.mkdir(corpusDir, { recursive: true });
    log(`manifest: ${MANIFEST_URL}`);
    manifest = JSON.parse(await withRetry("manifest fetch", () => getString(MANIFEST_URL)));
    const art = manifest.artifact || {};
    if (!art.url || !art.sha256) throw new Error("manifest is missing artifact.url / artifact.sha256");
    const gzMB = art.sizeBytesGzipped ? fmtMB(art.sizeBytesGzipped) : "?";
    log(`tag ${manifest.tag || "?"} · ${art.filename || art.url.split("/").pop()} (${gzMB} gzipped)`);

    await withRetry("download", async () => {
      log(`downloading → ${corpusFile} …`);
      let last = 0;
      await streamToFile(art.url, partialGz, (b) => {
        if (b - last > 4 * 1024 * 1024) { last = b; process.stdout.write(`  ${fmtMB(b)}\r`); }
      });
      process.stdout.write("\n");
      log("verifying sha256 …");
      const sha = await sha256File(partialGz);
      if (sha !== art.sha256) throw new Error(`sha256 mismatch: got ${sha.slice(0, 16)}…, expected ${art.sha256.slice(0, 16)}…`);
      log("decompressing …");
      await gunzipFile(partialGz, partialDb);
      await safeUnlink(partialGz);
      fs.renameSync(partialDb, corpusFile);          // atomic replace
      await fsp.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
    }).catch(async (err) => { await safeUnlink(partialGz); await safeUnlink(partialDb); throw err; });

    log(`✓ corpus installed → ${corpusFile} (${fmtMB(fs.statSync(corpusFile).size)})`);
  }

  // Embedder staging runs EVEN when the corpus install was skipped — a
  // server that installed rel17-v7 before this script learned to stage the
  // embedder can pick it up by simply re-running the installer.
  await stageEmbedder(manifest);

  log("Done. The corpus + embedder are shared by every user on this server.");
  log("Restart the app (docker compose restart) if it was already running.");
}

main().catch((err) => { console.error(`[install-corpus] FAILED: ${err.message}`); process.exit(1); });
