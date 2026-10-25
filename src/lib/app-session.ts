// src/lib/app-session.ts — the desktop app's own session credential.
//
// The packaged app ships NO NEXTAUTH_SECRET: a symmetric signing key must
// not live in a client binary, and the app's local server therefore could not
// verify the backend's session cookie. Every signed-in user was bounced back
// to /auth/signin (src/proxy.ts) even though the backend had issued a valid
// session.
//
// So the backend issues a SECOND credential for the app: an Ed25519-signed
// token. The app ships only the PUBLIC key and verifies it locally — it can
// check the session, but nobody outside the backend can mint one.
//
// Key material (base64url-encoded JWK JSON):
//   ORPLEX_SESSION_PRIVATE_KEY  backend only  (sign)
//   ORPLEX_SESSION_PUBLIC_KEY   backend + app (verify)

import { SignJWT, jwtVerify, importJWK, type JWK, type KeyLike } from "jose";

export const APP_SESSION_COOKIE = "orplex-app-session";
/** Matches the next-auth session lifetime (7 days). */
export const APP_SESSION_MAX_AGE = 7 * 24 * 60 * 60;

export interface AppSessionUser {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

function readJwk(envName: string): JWK | null {
  const raw = (process.env[envName] || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as JWK;
  } catch {
    return null;
  }
}

async function importEd25519(envName: string): Promise<KeyLike | Uint8Array | null> {
  const jwk = readJwk(envName);
  if (!jwk) return null;
  try {
    return await importJWK(jwk, "EdDSA");
  } catch {
    return null;
  }
}

/** Sign a session for the app. Null when the backend has no private key. */
export async function signAppSession(user: AppSessionUser): Promise<string | null> {
  const key = await importEd25519("ORPLEX_SESSION_PRIVATE_KEY");
  if (!key) return null;
  return new SignJWT({
    id: user.id,
    name: user.name ?? null,
    email: user.email ?? null,
    image: user.image ?? null,
  })
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${APP_SESSION_MAX_AGE}s`)
    .sign(key);
}

/** Verify an app session token. Null for forged, tampered or expired tokens. */
export async function verifyAppSession(token: string | null | undefined): Promise<AppSessionUser | null> {
  if (!token) return null;
  const key = await importEd25519("ORPLEX_SESSION_PUBLIC_KEY");
  if (!key) return null;
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["EdDSA"] });
    const id =
      typeof payload.id === "string" && payload.id
        ? payload.id
        : typeof payload.sub === "string"
          ? payload.sub
          : "";
    if (!id) return null;
    return {
      id,
      name: typeof payload.name === "string" ? payload.name : null,
      email: typeof payload.email === "string" ? payload.email : null,
      image: typeof payload.image === "string" ? payload.image : null,
    };
  } catch {
    return null;
  }
}

/** Pull one cookie value out of a raw Cookie header. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    const value = trimmed.slice(eq + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/** The signed-in app user from a request's cookies (no secret required). */
export async function appSessionUserFromRequest(req: {
  headers: { get(name: string): string | null };
}): Promise<AppSessionUser | null> {
  const token = readCookie(req.headers.get("cookie"), APP_SESSION_COOKIE);
  return verifyAppSession(token);
}
