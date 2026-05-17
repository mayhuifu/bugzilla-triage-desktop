import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Read the version from package.json at build time so it can be shown
// in the UI (next to the Logo). `process.env.NEXT_PUBLIC_*` is the
// canonical Next.js mechanism for build-time injection that's safe to
// read from both server and client components.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf8"));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Bundle the Next.js server + only the npm deps it actually uses into
  // .next/standalone — that subdirectory becomes the entire Node.js
  // server payload electron-builder ships inside the Windows installer.
  // No system Node install needed at runtime.
  output: "standalone",
  // Native modules must NOT be bundled by webpack — they must be loaded
  // at runtime via require(). better-sqlite3 ships a per-platform .node
  // binary that the bundler can't process. Telling Next.js to externalize
  // it preserves the require() resolution from .next/standalone/node_modules
  // where electron-builder will unpack the prebuild.
  serverExternalPackages: ["better-sqlite3"],
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
};

export default nextConfig;
