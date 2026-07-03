// ─────────────────────────────────────────────────────────────────
// lib/corpus/manifest.ts — local + remote manifest helpers.
//
// The corpus build pipeline (in the bugzilla-triage-corpus repo) emits
// a manifest.json alongside each corpus.sqlite.gz release. Shape:
//
//   {
//     "schemaVersion": 1,
//     "release":       "Rel-17",
//     "tag":           "rel17-v1",
//     "builtAt":       "2026-05-17T03:23:00Z",
//     "artifact": {
//       "filename":             "3gpp-corpus-rel17-v1-2026-05.sqlite.gz",
//       "url":                  "https://github.com/.../<filename>",
//       "sizeBytesGzipped":     11000000,
//       "sizeBytesUncompressed":40400000,
//       "sha256":               "<hex>"
//     }
//   }
//
// The local mirror lives at <userData>/corpus/manifest.json after a
// successful download so we can:
//   - report "what version is installed" without opening the SQLite
//   - compare local vs remote to surface "update available"
//
// The remote URL comes from settings.corpusManifestUrl. The default
// points at GitHub Releases; users in GitHub-blocked networks (mainland
// China) override to an internal SharePoint URL. The manifest's `url`
// field then determines where the .sqlite.gz itself is fetched, so the
// override flows end-to-end without further config.
// ─────────────────────────────────────────────────────────────────

import "server-only";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as https from "node:https";
import * as http from "node:http";

import { appDataDir } from "../settings";

export interface CorpusManifest {
  schemaVersion: number;
  release: string;
  tag: string;
  builtAt: string;
  /** Which embedding model built the corpus's dense vectors (rel17-v7+
   *  manifests; e.g. "BAAI/bge-m3"). The download flow uses it to stage
   *  the matching query embedder as part of the corpus install. Absent
   *  on older manifests → no embedder staging step. */
  embeddingModel?: string;
  embeddingDim?: number;
  embeddingDtype?: string;
  artifact: {
    filename: string;
    url: string;
    sizeBytesGzipped: number;
    sizeBytesUncompressed: number;
    sha256: string;
  };
}

// Corpus v1 ships pure FTS5 BM25. v2 adds sqlite-vec dense vectors +
// hierarchy in FTS5 + acronyms + eval_queries (corpus repo SPEC.md §14).
// v3 adds the figure_images table carrying inline SVG/PNG/JPEG bytes for
// every captioned figure (corpus repo SPEC.md ADR-009). The bump is
// additive — v3 corpora work fine on v2 clients (the new table is just
// ignored), and v2 corpora work fine on this v3-aware client (the
// SpecDrawer just doesn't render figures, same as before).
// v4 (corpus rel17-v6, Phase B): Docling parse + VLM figure captions. Additive
// over v3 — captions ride in clauses.text + figures_json.vlmCaption, so a v3-
// aware read path still works (it just ignores the new field). Listed so the
// v0.5.6 desktop accepts the rel17-v6 manifest.
const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2, 3, 4]);

function localManifestPath(): string {
  return path.join(appDataDir(), "corpus", "manifest.json");
}

/** Read the manifest of the currently-installed corpus. Returns null
 *  when nothing has been downloaded yet (or the sidecar is missing). */
export async function readLocalManifest(): Promise<CorpusManifest | null> {
  try {
    const raw = await fs.readFile(localManifestPath(), "utf8");
    const parsed = JSON.parse(raw) as CorpusManifest;
    if (!SUPPORTED_SCHEMA_VERSIONS.has(parsed?.schemaVersion)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist the manifest sidecar after a successful download. Permissions
 *  0o600 mirror the settings.json policy (per-user, not world-readable). */
export async function writeLocalManifest(manifest: CorpusManifest): Promise<void> {
  const dir = path.dirname(localManifestPath());
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    localManifestPath(),
    JSON.stringify(manifest, null, 2),
    { mode: 0o600 },
  );
}

/** True for failures worth retrying: transport-level errors (ECONNRESET,
 *  timeouts, socket hang-ups — routine on GitHub connections from some
 *  networks) and retryable HTTP statuses. HTTP 4xx (except 429) and
 *  JSON/schema problems are NOT transient — retrying can't fix them. */
function isTransientNetError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const httpStatus = msg.match(/^HTTP (\d{3}) /);
  if (httpStatus) {
    const s = Number(httpStatus[1]);
    return s === 429 || s >= 500;
  }
  return true; // non-HTTP failure → transport-level → retryable
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Fetch the remote manifest from settings.corpusManifestUrl. Uses
 *  node:https directly to match the rest of the codebase's outbound HTTP
 *  style (see lib/bugzilla.ts) and to avoid Next.js fetch-bundling
 *  issues with corporate proxies + self-signed certs.
 *
 *  RETRIES transient network failures (4 attempts, exponential backoff +
 *  jitter): connections to github.com get reset intermittently on some
 *  networks (observed ECONNRESET on the "check for updates" click), and
 *  the manifest is a sub-kilobyte file — a couple of retries turn a flaky
 *  route into a reliable check. Persistent failures surface a message
 *  that points at the internal-mirror override. */
export async function fetchRemoteManifest(url: string, opts: { timeoutMs?: number } = {}): Promise<CorpusManifest> {
  const attempts = 4;
  let text = "";
  for (let i = 0; ; i++) {
    try {
      text = await httpGetString(url, opts.timeoutMs ?? 15_000);
      break;
    } catch (err) {
      if (i >= attempts - 1 || !isTransientNetError(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${msg} (after ${i + 1} attempt${i ? "s" : ""}). If github.com is unstable or blocked ` +
          `on this network, set the Manifest URL to an internal mirror hosting the same files.`,
        );
      }
      await sleep(Math.min(4_000, 500 * 2 ** i) + Math.floor(Math.random() * 250));
    }
  }
  let parsed: CorpusManifest;
  try {
    parsed = JSON.parse(text) as CorpusManifest;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`manifest is not valid JSON: ${msg}. First 200 chars: ${text.slice(0, 200)}`);
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.has(parsed?.schemaVersion)) {
    const supported = Array.from(SUPPORTED_SCHEMA_VERSIONS).join(", ");
    throw new Error(`unsupported manifest schemaVersion=${parsed?.schemaVersion} (this app supports {${supported}})`);
  }
  if (!parsed.artifact?.url || !parsed.artifact?.sha256) {
    throw new Error(`manifest is missing required artifact.url / artifact.sha256 fields`);
  }
  return parsed;
}

function httpGetString(url: string, timeoutMs: number, redirects = 3): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({
      method: "GET",
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      timeout: timeoutMs,
      headers: { "User-Agent": "bugzilla-triage-desktop/0.1.6 corpus-manifest" },
    }, res => {
      const status = res.statusCode ?? 0;
      // GitHub Releases issues 302 to S3; follow up to `redirects` hops.
      if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        httpGetString(next, timeoutMs, redirects - 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${status} from ${url}`));
      }
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`manifest fetch timeout after ${timeoutMs}ms`)));
    req.end();
  });
}

/** Returns true when remote.tag is lexically newer than local.tag. The
 *  tag convention is `relNN-vM` — both segments are integers, so a
 *  simple split-and-compare suffices. Returns false on tag-format
 *  mismatches (safer to skip than auto-update an unfamiliar tag). */
export function isRemoteNewer(local: CorpusManifest | null, remote: CorpusManifest): boolean {
  if (!local) return true;
  const parse = (tag: string) => tag.match(/^rel(\d+)-v(\d+)$/i);
  const l = parse(local.tag);
  const r = parse(remote.tag);
  if (!l || !r) return false;
  if (Number(r[1]) !== Number(l[1])) return Number(r[1]) > Number(l[1]); // newer release
  return Number(r[2]) > Number(l[2]);                                     // same release, higher v
}
