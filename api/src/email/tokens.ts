// Refresh tokens are stored AES-256-GCM encrypted. Format: v1.<iv>.<tag>.<ciphertext> (base64url).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { emailConfig } from "../config";

function key(): Buffer {
  const raw = emailConfig().tokenKey;
  if (!raw) throw new Error("EMAIL_TOKEN_KEY is required (32 bytes, base64: openssl rand -base64 32).");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("EMAIL_TOKEN_KEY must decode to exactly 32 bytes.");
  return k;
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function decryptToken(stored: string): string {
  const [version, iv, tag, data] = stored.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Unrecognized token format.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
