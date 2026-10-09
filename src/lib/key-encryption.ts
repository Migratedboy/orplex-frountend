import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function getSecret(): Buffer {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret || secret.length < 64) {
    // Fail CLOSED in production: the old dev-fallback key is published in
    // this repo, so any "encrypted" key would be decryptable by anyone.
    // Refusing is the only safe behavior — set a 64+ hex ENCRYPTION_SECRET.
    if (process.env.NODE_ENV === "production") {
      throw new Error("ENCRYPTION_SECRET is missing or too short (need 64+ hex chars) — refusing to encrypt with the dev key");
    }
    // Development fallback — NOT for production
    return Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");
  }
  return Buffer.from(secret, "hex");
}

export function encryptKey(plainText: string): string {
  const secret = getSecret();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, secret, iv);

  let encrypted = cipher.update(plainText, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag();

  // Format: iv:tag:ciphertext (all hex)
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted}`;
}

export function decryptKey(cipherText: string): string {
  const secret = getSecret();
  const parts = cipherText.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted key format");

  const iv = Buffer.from(parts[0], "hex");
  const tag = Buffer.from(parts[1], "hex");
  const encrypted = parts[2];

  const decipher = createDecipheriv(ALGORITHM, secret, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export function maskKey(plainText: string): string {
  if (plainText.length <= 8) return "****";
  return plainText.slice(0, 6) + "..." + plainText.slice(-4);
}
