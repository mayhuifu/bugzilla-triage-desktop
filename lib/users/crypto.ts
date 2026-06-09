// lib/users/crypto.ts — AES-256-GCM encryption for at-rest user secrets
// (Bugzilla + LLM API keys in profiles.db). Key is derived from APP_SECRET,
// which is REQUIRED in server mode (validated at store init). Format:
//   "<iv-b64>.<authtag-b64>.<ciphertext-b64>"
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const ALGO = "aes-256-gcm";

function key(): Buffer {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 16) {
    throw new Error("APP_SECRET (≥16 chars) is required to encrypt user secrets in server mode.");
  }
  // Derive a stable 32-byte key from the configured secret.
  return createHash("sha256").update(s, "utf8").digest();
}

/** Encrypt a UTF-8 secret. Empty input → empty output (no-op for unset keys). */
export function encryptSecret(plain: string): string {
  if (!plain) return "";
  const iv = randomBytes(12);
  const c = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

/** Decrypt a blob produced by encryptSecret. Empty → empty. Throws on tamper
 *  (GCM auth failure) or malformed input. */
export function decryptSecret(blob: string): string {
  if (!blob) return "";
  const [ivB, tagB, encB] = blob.split(".");
  if (!ivB || !tagB || !encB) throw new Error("malformed encrypted secret");
  const d = createDecipheriv(ALGO, key(), Buffer.from(ivB, "base64"));
  d.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([d.update(Buffer.from(encB, "base64")), d.final()]).toString("utf8");
}
