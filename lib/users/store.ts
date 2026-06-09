// lib/users/store.ts — writable profiles.db (better-sqlite3): per-user profiles
// and opaque session tokens. SEPARATE from the read-only corpus DB. Secrets are
// encrypted at rest (crypto.ts); UserProfile carries them DECRYPTED in memory.
import { createRequire } from "node:module";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

import { appDataDir } from "../settings";   // relative (not @/) so the tsx self-check loads it without path-alias config
import { encryptSecret, decryptSecret } from "./crypto";

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3");

export interface UserProfile {
  email: string;
  bugzillaApiKey: string;   // decrypted
  llmProvider: string;      // "anthropic" | "openai-compatible" | "claude-cli" | "codex-cli"
  llmBaseUrl: string;
  llmApiKey: string;        // decrypted; "" when useCompanyLlm
  defaultModel: string;
  useCompanyLlm: boolean;
  themeMode: string;        // "system" | "light" | "dark"
}

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  const p = process.env.PROFILES_DB || path.join(appDataDir(), "profiles.db");
  const instance = new BetterSqlite3(p);
  instance.pragma("journal_mode = WAL");
  instance.exec(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      bugzilla_key_enc TEXT NOT NULL,
      llm_provider TEXT NOT NULL DEFAULT 'anthropic',
      llm_base_url  TEXT NOT NULL DEFAULT '',
      llm_key_enc   TEXT NOT NULL DEFAULT '',
      default_model TEXT NOT NULL DEFAULT '',
      use_company_llm INTEGER NOT NULL DEFAULT 0,
      theme_mode    TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, email TEXT NOT NULL,
      created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
    );
  `);
  _db = instance;
  return _db as Database.Database;
}

export interface UpsertInput {
  email: string; bugzillaApiKey: string;
  llmProvider: string; llmBaseUrl: string; llmApiKey: string;
  defaultModel: string; useCompanyLlm: boolean; themeMode: string;
}

export function upsertUser(p: UpsertInput): void {
  const now = new Date().toISOString();
  db().prepare(`
    INSERT INTO users (email, bugzilla_key_enc, llm_provider, llm_base_url, llm_key_enc,
                       default_model, use_company_llm, theme_mode, created_at, updated_at)
    VALUES (@email, @bk, @prov, @base, @lk, @model, @company, @theme, @now, @now)
    ON CONFLICT(email) DO UPDATE SET
      bugzilla_key_enc=@bk, llm_provider=@prov, llm_base_url=@base, llm_key_enc=@lk,
      default_model=@model, use_company_llm=@company, theme_mode=@theme, updated_at=@now
  `).run({
    email: p.email.toLowerCase().trim(),
    bk: encryptSecret(p.bugzillaApiKey),
    prov: p.llmProvider, base: p.llmBaseUrl,
    lk: encryptSecret(p.llmApiKey),
    model: p.defaultModel, company: p.useCompanyLlm ? 1 : 0,
    theme: p.themeMode, now,
  });
}

export function getUser(email: string): UserProfile | null {
  const r = db().prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase().trim()) as any;
  if (!r) return null;
  return {
    email: r.email,
    bugzillaApiKey: decryptSecret(r.bugzilla_key_enc),
    llmProvider: r.llm_provider, llmBaseUrl: r.llm_base_url,
    llmApiKey: decryptSecret(r.llm_key_enc),
    defaultModel: r.default_model, useCompanyLlm: !!r.use_company_llm,
    themeMode: r.theme_mode,
  };
}

/** Create an opaque session token bound to an email. */
export function createSession(email: string): string {
  const token = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  db().prepare("INSERT INTO sessions (token, email, created_at, last_seen_at) VALUES (?,?,?,?)")
    .run(token, email.toLowerCase().trim(), now, now);
  return token;
}

/** Resolve a session token → that user's profile, bumping last_seen. null if
 *  the token is unknown or the user was deleted. */
export function resolveSession(token: string): UserProfile | null {
  if (!token) return null;
  const s = db().prepare("SELECT email FROM sessions WHERE token = ?").get(token) as any;
  if (!s) return null;
  db().prepare("UPDATE sessions SET last_seen_at = ? WHERE token = ?").run(new Date().toISOString(), token);
  return getUser(s.email);
}
