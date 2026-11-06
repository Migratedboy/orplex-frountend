/**
 * session-cookies.ts — the complete set of session credentials this app mints,
 * and helpers to expire all of them.
 *
 * Why this exists: a single sign-out used to clear only the cookie NextAuth
 * manages. The desktop/Electron flow also mints `__Secure-next-auth.session-token`
 * and the app's own Ed25519 `orplex-app-session` (see app/api/auth/desktop/exchange),
 * and readers (server-session.ts, proxy.ts, mcp-auth.ts) prefer those names. A
 * leftover credential from account A therefore survived sign-out and made a
 * subsequent login resolve as A ("logged out of A, logged in as B, still A").
 *
 * Clearing every name, with attributes that match how each was set, is the fix.
 * httpOnly cookies cannot be removed from client JS, so callers expire them via
 * Set-Cookie on a server response.
 */
import { NextResponse } from "next/server";
import { APP_SESSION_COOKIE } from "@/lib/app-session";

/** Every session cookie name the app may have set on this origin. */
export const ALL_SESSION_COOKIE_NAMES = [
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
  APP_SESSION_COOKIE, // "orplex-app-session"
] as const;

/**
 * Expire every session credential on `res`. Each name is cleared with the
 * attribute shape it was issued with (the `__Secure-` prefix requires
 * `secure: true`; the others are cleared both secure and non-secure so a cookie
 * set under either flag is dropped — browsers key deletion on name+path+domain,
 * and a Secure cookie is only removed by a Secure clear).
 */
export function clearAllSessionCookies(res: NextResponse): void {
  const base = {
    httpOnly: true as const,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  };

  // `__Secure-` was always set with secure:true (desktop exchange) and the
  // prefix itself mandates Secure — a non-secure clear cannot drop it.
  res.cookies.set("__Secure-next-auth.session-token", "", { ...base, secure: true });

  // The unprefixed NextAuth token and the app session were set with
  // secure = (production && !loopback) by the desktop exchange, and with
  // secure:false by the dev-session route / plain http flows. Issue clears for
  // both so whichever variant is present is removed.
  for (const name of ["next-auth.session-token", APP_SESSION_COOKIE] as const) {
    res.cookies.set(name, "", { ...base, secure: false });
    res.cookies.set(name, "", { ...base, secure: true });
  }
}

/** Build a JSON response that also expires every session credential. */
export function clearedSessionResponse(body: unknown = { ok: true }): NextResponse {
  const res = NextResponse.json(body);
  clearAllSessionCookies(res);
  return res;
}
