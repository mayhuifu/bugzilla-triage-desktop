// scripts/dev-twouser-test.mjs — LOCAL two-user multi-user acceptance, no real
// Bugzilla account needed. Drives the dev server (must be running in MULTI_USER
// mode against scripts/dev-fake-bugzilla.mjs) as TWO independent users and
// asserts the platform's multi-user guarantees:
//
//   1. No session            → 401          (gate)
//   2. Setup A + Setup B      → 200 + cookie  (self-registration)
//   3. /api/whoami as A       → identity A    (act-as-user: A's stored key used)
//   4. /api/whoami as B       → identity B    (act-as-user: B's stored key used)
//   5. cache no-leak          → B (no fresh)  still resolves to B, not cached A
//   6. fake-Bugzilla log      → A's reqs carried A's key, B's carried B's key
//   7. profiles.db            → two users, keys encrypted at rest
//
// Run (after the server + fake are up):  node scripts/dev-twouser-test.mjs
import { createRequire } from "node:module";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const FAKE = process.env.FAKE_BZ_URL || "http://127.0.0.1:9099";
const DB = process.env.PROFILES_DB || "/tmp/mu2-profiles.db";

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${msg}`); if (!cond) failures++; };

function cookieFrom(res) {
  const set = res.headers.getSetCookie?.() || [];
  const c = set.find(s => s.startsWith("bt_session="));
  return c ? c.split(";")[0] : "";   // "bt_session=<token>"
}

async function setup(email, key) {
  const res = await fetch(`${BASE}/api/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, bugzillaApiKey: key, useCompanyLlm: true }),
  });
  return { status: res.status, body: await res.json().catch(() => null), cookie: cookieFrom(res) };
}

async function whoami(cookie, fresh) {
  const res = await fetch(`${BASE}/api/whoami${fresh ? "?fresh=1" : ""}`, {
    headers: cookie ? { cookie } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function waitReady(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/api/setup`);
      const b = await r.json();
      if (r.status === 200 && b.multiUser === true) return true;
    } catch { /* server still compiling */ }
    await new Promise(res => setTimeout(res, 1000));
  }
  return false;
}

void (async () => {
  console.log(`two-user test → ${BASE}  (fake bugzilla ${FAKE})`);
  const ready = await waitReady();
  ok(ready, "dev server is up in MULTI_USER mode (/api/setup → multiUser:true)");
  if (!ready) { console.log("\n❌ server not ready — aborting"); process.exit(1); }
  await fetch(`${FAKE}/__reset`).catch(() => {});

  // 1. gate
  const noSession = await whoami("", true);
  ok(noSession.status === 401, `no session → 401 (got ${noSession.status})`);

  // 2. setup A + B (distinct keys)
  const KA = "KEY-ALICE-aaa", KB = "KEY-BOB-bbb";
  const A = await setup("alice@local.test", KA);
  const B = await setup("bob@local.test", KB);
  ok(A.status === 200 && A.cookie, `setup A → 200 + cookie (got ${A.status})`);
  ok(B.status === 200 && B.cookie, `setup B → 200 + cookie (got ${B.status})`);
  ok(A.cookie !== B.cookie, "A and B got distinct session cookies");

  // 3/4. act-as-user: each session's /api/whoami reflects ITS key (fresh bypasses cache)
  const wA = await whoami(A.cookie, true);
  const wB = await whoami(B.cookie, true);
  ok(wA.body?.login === `bzuser:${KA}`, `A whoami identity = A's key (got ${wA.body?.login})`);
  ok(wB.body?.login === `bzuser:${KB}`, `B whoami identity = B's key (got ${wB.body?.login})`);

  // 5. cache no-leak: warm A's cache (no fresh), then B (no fresh) must NOT get A's
  await whoami(A.cookie, false);                 // populates cache under A's scope
  const wBcached = await whoami(B.cookie, false); // must resolve to B, not cached A
  ok(wBcached.body?.login === `bzuser:${KB}`,
     `B (cached path) still = B, no cross-user cache leak (got ${wBcached.body?.login})`);

  // 6. fake-bugzilla saw the right key per user, never the wrong one
  const seen = await (await fetch(`${FAKE}/__log`)).json();
  const keysForWhoami = seen.filter(e => e.path === "/rest/whoami").map(e => e.api_key);
  ok(keysForWhoami.includes(KA) && keysForWhoami.includes(KB),
     `fake saw both keys on /rest/whoami (${[...new Set(keysForWhoami)].join(", ")})`);
  ok(keysForWhoami.every(k => k === KA || k === KB),
     "fake never saw an unexpected key (no leakage of other creds)");

  // 7. profiles.db: two users, keys encrypted (ciphertext != plaintext)
  try {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    const db = new Database(DB, { readonly: true });
    const rows = db.prepare("SELECT email, bugzilla_key_enc FROM users ORDER BY email").all();
    db.close();
    ok(rows.length === 2, `profiles.db has 2 users (got ${rows.length})`);
    ok(rows.every(r => r.bugzilla_key_enc && !String(r.bugzilla_key_enc).includes("KEY-")),
       "stored Bugzilla keys are encrypted at rest (no plaintext)");
  } catch (e) {
    ok(false, `profiles.db inspection failed: ${e.message}`);
  }

  console.log(failures === 0
    ? "\n✅ TWO-USER TEST PASSED — act-as-user + no cross-user leak"
    : `\n❌ ${failures} assertion(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
