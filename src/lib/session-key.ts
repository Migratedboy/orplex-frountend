// session-key.ts — which key(s) may verify the app session.
//
// The app ships the backend's PUBLIC session key inside its installer. That key
// is correct until the backend rotates it, and the failure mode then is brutal
// and silent: the cookie is valid, the signature is unreadable with the outdated
// key, and every request bounces to /auth/signin with no error anywhere.
//
// So verification accepts either:
//   1. the key baked into this build (works offline, no round-trip), or
//   2. the key the configured backend currently signs with — fetched once,
//      cached, and only when a token actually failed.
//
// The fetched key is trusted because it comes from the app's own configured API
// origin over TLS, and it can only VERIFY a token — a wrong or hostile key
// cannot mint a session, it just fails.

import { backendBaseUrl } from "@/lib/backend-client";

export interface SessionKeyInfo {
  keyId: string;
  publicKey: string;
}

const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;

let cached: SessionKeyInfo | null = null;
let cachedAt = 0;
let failedAt = 0;
let inFlight: Promise<SessionKeyInfo | null> | null = null;

/** The key compiled into / configured for this install. */
export function bundledSessionKey(): string | null {
  const raw = (process.env.ORPLEX_SESSION_PUBLIC_KEY || "").trim();
  return raw || null;
}

/** Forget the cached key (tests, or after a key rotation is detected). */
export function resetSessionKeyCache(): void {
  cached = null;
  cachedAt = 0;
  failedAt = 0;
  inFlight = null;
}

function isFreshKey(info: SessionKeyInfo | null): info is SessionKeyInfo {
  return !!info && Date.now() - cachedAt < CACHE_TTL_MS;
}

/**
 * Ask the backend which public key it signs app sessions with.
 * Returns null on any failure — a network hiccup must degrade to "use the
 * bundled key", never to "nobody is signed in".
 */
export async function fetchSessionKey(base = backendBaseUrl()): Promise<SessionKeyInfo | null> {
  if (!base) return null;
  // Unit tests opt in explicitly: a signature check must never depend on the
  // live backend being reachable, and a test run must never call out.
  if (process.env.NODE_ENV === "test" && process.env.ORPLEX_SESSION_KEY_REMOTE !== "1") return null;
  if (isFreshKey(cached)) return cached;
  if (Date.now() - failedAt < FAILURE_TTL_MS) return null;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch(`${base.replace(/\/+$/, "")}/api/system/session-key`, {
        cache: "no-store",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        failedAt = Date.now();
        return null;
      }
      const body = (await res.json()) as { publicKey?: unknown; keyId?: unknown };
      if (typeof body.publicKey !== "string" || !body.publicKey) {
        failedAt = Date.now();
        return null;
      }
      cached = {
        publicKey: body.publicKey,
        keyId: typeof body.keyId === "string" ? body.keyId : "",
      };
      cachedAt = Date.now();
      failedAt = 0;
      return cached;
    } catch {
      failedAt = Date.now();
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Keys to try, most authoritative first. The bundled key is tried first because
 * it needs no network; the backend key is only consulted after a token fails.
 */
export async function sessionKeyCandidates(includeRemote = false): Promise<string[]> {
  const keys: string[] = [];
  const bundled = bundledSessionKey();
  if (bundled) keys.push(bundled);
  const remote = cached ?? (includeRemote ? await fetchSessionKey() : null);
  if (remote?.publicKey && !keys.includes(remote.publicKey)) keys.push(remote.publicKey);
  return keys;
}
