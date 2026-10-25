// src/lib/desktop-auth.ts — desktop sign-in handoff primitives.
//
// The desktop OAuth flow spans four HTTP requests that can land on DIFFERENT
// serverless instances (Vercel): mint (start) → OAuth round-trip (provider) →
// arm (finish) → exchange (app). Module-level state therefore cannot carry
// the flow: an in-memory Map made every login a coin flip on the cold-start
// path. Everything here is stateless instead:
//
//   code  = base64url(payload) + "." + HMAC-SHA256(payload, NEXTAUTH_SECRET)
//   grant = base64url(iv) + "." + base64url(tag) + "." + base64url(ciphertext)
//
// The code travels through the provider round-trip (start → finish); the grant
// travels through the app deep link (finish → exchange). Both are tamper-proof
// (HMAC / AES-GCM) and self-expiring.

import crypto from "node:crypto";

export interface DesktopAuthSession {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

/** Claims carried by a desktop sign-in code. */
export interface DesktopCodeClaims {
  provider: string;
  /** sha256 of the initiator cookie (see mintDesktopCode). */
  flowHash: string;
  exp: number;
}

const CODE_TTL_MS = 5 * 60_000;
/** The grant is handed to the app and burned quickly — keep it short. */
const GRANT_TTL_MS = 2 * 60_000;

/** Initiator-binding cookie name (minted at start, verified at finish). */
export const DESKTOP_FLOW_COOKIE = "orplex_desktop_flow";

function secret(): string {
  const value = (process.env.NEXTAUTH_SECRET || "").trim();
  if (!value) throw new Error("NEXTAUTH_SECRET is not set");
  return value;
}

function b64u(buf: Buffer): string {
  return buf.toString("base64url");
}

function unb64u(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

function equalConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Mint a one-time sign-in code for a provider plus the initiator token that
 * binds the flow to the browser that started it.
 */
export function mintDesktopCode(provider: string): { code: string; flowToken: string } {
  const flowToken = crypto.randomBytes(32).toString("base64url");
  const flowHash = crypto.createHash("sha256").update(flowToken).digest("hex");
  const claims: DesktopCodeClaims = { provider, flowHash, exp: Date.now() + CODE_TTL_MS };
  const payload = b64u(Buffer.from(JSON.stringify(claims), "utf8"));
  return { code: `${payload}.${sign(payload)}`, flowToken };
}

/**
 * Verify a code's signature and expiry. Returns null for anything forged,
 * malformed or expired.
 */
export function readDesktopCode(code: string): DesktopCodeClaims | null {
  const parts = (code || "").split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  let expected: string;
  try {
    expected = sign(payload);
  } catch {
    return null;
  }
  if (!equalConstantTime(signature, expected)) return null;
  try {
    const claims = JSON.parse(unb64u(payload).toString("utf8")) as DesktopCodeClaims;
    if (!claims || typeof claims.exp !== "number" || claims.exp < Date.now()) return null;
    if (!claims.provider || !claims.flowHash) return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * Verify the arming browser is the minting browser (double-submit cookie
 * pattern): the token never leaves HttpOnly cookie storage, so a cross-site
 * attacker cannot present it. Timing-safe; false on any mismatch.
 */
export function checkDesktopFlow(
  claims: DesktopCodeClaims | null,
  flowToken: string | null | undefined
): boolean {
  if (!claims || !flowToken) return false;
  try {
    const hash = crypto.createHash("sha256").update(flowToken).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(claims.flowHash, "hex"));
  } catch {
    return false;
  }
}

function grantKey(): Buffer {
  return crypto.createHash("sha256").update(`orplex-desktop-grant:${secret()}`).digest();
}

/** Encrypt a signed-in identity into a bearer grant the app can redeem. */
export function mintDesktopGrant(session: DesktopAuthSession): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", grantKey(), iv);
  const payload = JSON.stringify({ ...session, exp: Date.now() + GRANT_TTL_MS });
  const body = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  return [b64u(iv), b64u(cipher.getAuthTag()), b64u(body)].join(".");
}

/** Decrypt + validate a grant. Null for forged, tampered or expired grants. */
export function readDesktopGrant(grant: string): DesktopAuthSession | null {
  const parts = (grant || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const [iv, tag, body] = parts.map(unb64u);
    const decipher = crypto.createDecipheriv("aes-256-gcm", grantKey(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]);
    const parsed = JSON.parse(plain.toString("utf8")) as DesktopAuthSession & { exp?: number };
    if (!parsed?.id) return null;
    if (typeof parsed.exp === "number" && parsed.exp < Date.now()) return null;
    return {
      id: parsed.id,
      name: parsed.name ?? null,
      email: parsed.email ?? null,
      image: parsed.image ?? null,
    };
  } catch {
    return null;
  }
}
