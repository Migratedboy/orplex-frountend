// server-session.ts — JWT session id for local route handlers.
//
// getServerSession(jwtOnlyOptions) computes the session-cookie NAME from the
// server URL's scheme: plain http (the desktop loopback) reads the non-secure
// `next-auth.session-token`, while sign-in happened on the https backend and
// the browser holds `__Secure-next-auth.session-token`. Chromium treats
// http://localhost as a secure context and sends the __Secure- cookie there,
// so the only failure is the NAME lookup — page middleware never hit this
// because proxy.ts already tries both names. Routes that run locally must do
// the same, which is all this helper does (next-auth/jwt only — importing
// authOptions would pull the PrismaAdapter chain into route bundles).

import { getToken } from "next-auth/jwt";
import type { NextRequest } from "next/server";

const SESSION_COOKIE_NAMES = [
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
] as const;

/** The signed-in user's id from either cookie name, or null. */
export async function sessionUserId(req: NextRequest): Promise<string | null> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return null;
  for (const cookieName of SESSION_COOKIE_NAMES) {
    try {
      const token = await getToken({ req, secret, cookieName });
      const id = (token as { id?: unknown } | null)?.id;
      if (typeof id === "string" && id.length > 0 && id.length <= 128) return id;
    } catch {}
  }
  return null;
}
