import { NextResponse } from "next/server";
import { APP_SESSION_COOKIE, readCookie, verifyAppSession } from "@/lib/app-session";
import { createHash } from "node:crypto";
import { bundledSessionKey, fetchSessionKey } from "@/lib/session-key";

export const dynamic = "force-dynamic";

/**
 * Short id for a key — the same value the backend publishes. Lives here, not in
 * session-key.ts: that module is imported by the middleware (edge runtime),
 * where node:crypto does not exist, and this is diagnostics only.
 */
function keyIdOf(base64urlJwk: string | null | undefined): string | null {
  if (!base64urlJwk) return null;
  try {
    const jwk = JSON.parse(Buffer.from(base64urlJwk, "base64url").toString("utf8")) as Record<string, unknown>;
    // Hash only the verifying half: a private-key JWK and its public twin then
    // produce the same id, which is what makes the two sides comparable.
    const normalized = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x });
    return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * "Why am I signed out?" — answered locally, without leaking the session.
 *
 * After sign-in the app verifies its own Ed25519 session cookie against the key
 * baked into this build. When that fails, every page bounces to /auth/signin
 * and the user cannot tell a stale key from an expired cookie from a cookie
 * that was never set. This route reports which of those it is, in key ids only:
 * the token itself and the key material are never returned.
 */
export async function GET(request: Request) {
  const token = readCookie(request.headers.get("cookie"), APP_SESSION_COOKIE);
  const user = await verifyAppSession(token);
  const bundled = bundledSessionKey();
  const remote = await fetchSessionKey();

  const bundledId = keyIdOf(bundled);
  const liveId = remote?.keyId || keyIdOf(remote?.publicKey);

  return NextResponse.json(
    {
      success: true,
      cookiePresent: !!token,
      verified: !!user,
      user: user ? { id: user.id, email: user.email ?? null } : null,
      // bundled == what this build can verify; backend == what signs sessions now
      keys: {
        bundled: bundledId,
        backend: liveId,
        match: !!bundledId && !!liveId && bundledId === liveId,
        backendReachable: !!remote,
      },
      diagnosis: user
        ? "ok"
        : !token
          ? "no-session-cookie"
          : bundledId && liveId && bundledId !== liveId
            ? "key-mismatch"
            : "token-unverifiable",
    },
    { headers: { "cache-control": "no-store" } }
  );
}
