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
// ─────────────────────────────────────────────────────────────────

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";
import crypto from "node:crypto";

const DEFAULT_MANIFEST_URL =
  "https://github.com/mayhuifu/bugzilla-triage-corpus/releases/download/rel17-v6/3gpp-corpus-rel17-v6-2026-06.manifest.json";
const APP_DIR_NAME = "bugzilla-triage-desktop";
const FORCE = process.argv.includes("--force");
const MANIFEST_URL = (process.env.CORPUS_MANIFEST_URL || DEFAULT_MANIFEST_URL).trim();

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

async function main() {
  if (fs.existsSync(corpusFile) && !FORCE) {
    log(`already installed → ${corpusFile} (${fmtMB(fs.statSync(corpusFile).size)})`);
    log("Nothing to do. Re-run with --force to replace it.");
    return;
  }

  await fsp.mkdir(corpusDir, { recursive: true });
  log(`manifest: ${MANIFEST_URL}`);
  const manifest = JSON.parse(await withRetry("manifest fetch", () => getString(MANIFEST_URL)));
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

  log(`✓ installed → ${corpusFile} (${fmtMB(fs.statSync(corpusFile).size)})`);
  log("This corpus is now shared by every user on this server. Restart the app");
  log("(docker compose restart) if it was already running so it reopens the file.");
}

main().catch((err) => { console.error(`[install-corpus] FAILED: ${err.message}`); process.exit(1); });
