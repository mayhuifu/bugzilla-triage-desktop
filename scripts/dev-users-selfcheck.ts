// scripts/dev-users-selfcheck.ts — verify crypto round-trip + store CRUD/session
// against a throwaway profiles.db. Run: npx tsx scripts/dev-users-selfcheck.ts
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

process.env.APP_SECRET = "selfcheck-secret-key-0123456789";
process.env.PROFILES_DB = path.join(os.tmpdir(), `profiles-selfcheck-${process.pid}.db`);

const assert = (c: unknown, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };

// Wrapped in an async IIFE: tsx transpiles to CJS (no top-level await), and the
// dynamic imports must run AFTER the env above is set. Relative paths, no ext.
void (async () => {
  const { encryptSecret, decryptSecret } = await import("../lib/users/crypto");
  const store = await import("../lib/users/store");

  // ── crypto round-trip + tamper ──
  const blob = encryptSecret("hunter2-bugzilla-key");
  assert(blob.split(".").length === 3, "blob has iv.tag.ct");
  assert(decryptSecret(blob) === "hunter2-bugzilla-key", "decrypt round-trips");
  assert(encryptSecret("") === "" && decryptSecret("") === "", "empty no-op");
  let tampered = false;
  try { decryptSecret(blob.slice(0, -2) + "xx"); } catch { tampered = true; }
  assert(tampered, "tampered blob throws (GCM auth)");

  // ── store CRUD + session ──
  store.upsertUser({
    email: "A@x.com", bugzillaApiKey: "bz-A", llmProvider: "openai-compatible",
    llmBaseUrl: "https://api.deepseek.com", llmApiKey: "llm-A", defaultModel: "deepseek-chat",
    useCompanyLlm: false, themeMode: "system",
  });
  const a = store.getUser("a@x.com"); // case-insensitive
  assert(a && a.bugzillaApiKey === "bz-A" && a.llmApiKey === "llm-A", "getUser decrypts");
  assert(a!.email === "a@x.com", "email normalized lowercase");
  const tok = store.createSession("a@x.com");
  const resolved = store.resolveSession(tok);
  assert(resolved && resolved.email === "a@x.com" && resolved.bugzillaApiKey === "bz-A", "session resolves to user");
  assert(store.resolveSession("bogus") === null, "bad token → null");

  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.PROFILES_DB + suffix, { force: true }); } catch { /* ignore */ }
  }
  console.log("✓ users selfcheck passed (crypto round-trip + tamper, store CRUD, sessions)");
})();
