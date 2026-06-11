# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Multi-user server image for Bugzilla AI Triage (MULTI_USER=1 baked in).
# The desktop installers are a separate path (electron-builder) — unaffected.
#
#   docker build -t bugzilla-triage:0.7.0 .
#   docker run -d -p 3000:3000 -v btdata:/data \
#     -e APP_SECRET=... -e BUGZILLA_URL=https://... bugzilla-triage:0.7.0
#
# Run it behind HTTPS (see deploy/) — the session cookie is Secure and
# browsers drop it over plain http on anything but localhost.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Toolchain for native deps: better-sqlite3 falls back to a node-gyp source
# build when its prebuilt binary can't be fetched (common on firewalled build
# hosts) — without python3/make/g++ that fallback hard-fails npm ci.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
# The Electron desktop binary is never used in the server image — skip its
# ~100 MB postinstall download.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Stage the query-time embedder (~56 MB). On an offline build host, pre-run
# `npm run fetch:model` on a connected machine and ship models/ in the build
# context — the test keeps an already-staged model from re-downloading.
RUN test -f models/Xenova/bge-small-en-v1.5/config.json || npm run fetch:model
RUN npm run build
# Stage the sqlite-vec platform package (name preserved, arch-agnostic): the
# runtime loads <cwd>/node_modules/sqlite-vec-linux-<arch>/vec0.so via a
# dynamic require the standalone tracer can't see.
RUN mkdir -p /vecpkg && cp -r node_modules/sqlite-vec-linux-* /vecpkg/

FROM node:22-bookworm-slim AS run
ENV NODE_ENV=production \
    MULTI_USER=1 \
    XDG_CONFIG_HOME=/data \
    PROFILES_DB=/data/profiles.db \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# Next standalone payload (includes traced node_modules: better-sqlite3,
# onnxruntime-node, @huggingface/transformers, pdfjs-dist)
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# (no public/ dir in this repo — assets are served from .next/static)
# Embedder model — resolved from <cwd>/models at runtime (embedder-bge.ts)
COPY --from=build /app/models ./models
# sqlite-vec platform package staged by the build stage (dir name preserved —
# matches the build arch: sqlite-vec-linux-x64 on x64 hosts, -arm64 on ARM)
COPY --from=build /vecpkg ./node_modules/
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/setup').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
