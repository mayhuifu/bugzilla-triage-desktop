// scripts/dev-fake-bugzilla.mjs — a throwaway fake Bugzilla for the LOCAL
// two-user multi-user test. It needs NO real Bugzilla account: it accepts any
// api_key, RECORDS which key each request carried, and echoes that key back in
// /rest/whoami's `name`. That lets the two-user driver prove, end-to-end, that
// session A's requests use A's key and session B's use B's — the core
// "act-as-user / no cross-contamination" property of the platform.
//
// Run:  FAKE_BZ_PORT=9099 node scripts/dev-fake-bugzilla.mjs
// Control endpoints:  GET /__log  → all requests seen (JSON)   GET /__reset → clear
import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_BZ_PORT || 9099);
const log = [];

function apiKeyOf(url) {
  try { return new URL(url, "http://x").searchParams.get("api_key") || ""; }
  catch { return ""; }
}

const server = createServer((req, res) => {
  const url = req.url || "/";
  const path = url.split("?")[0];
  const json = (obj, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (path === "/__log") return json(log);
  if (path === "/__reset") { log.length = 0; return json({ ok: true }); }

  const api_key = apiKeyOf(url);
  log.push({ path, api_key });

  if (path === "/rest/whoami") {
    // Echo the key INTO the identity so the app's /api/whoami response reveals
    // which key the session actually used.
    return json({ id: 1000 + (api_key.length % 1000), name: `bzuser:${api_key}`, real_name: `Fake ${api_key}` });
  }
  if (path === "/rest/product") return json({ products: [{ id: 1, name: "FakeProduct" }] });
  if (path.startsWith("/rest/bug")) return json({ bugs: [] });
  return json({});
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fake-bugzilla listening on http://127.0.0.1:${PORT}`);
});
