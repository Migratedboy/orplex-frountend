import { NextResponse } from "next/server";
import { encode } from "next-auth/jwt";
import { readDesktopGrant } from "@/lib/desktop-auth";
import { APP_SESSION_COOKIE, signAppSession } from "@/lib/app-session";
import { checkRateLimit, clientIp } from "@/lib/rate-limiter";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Matches authOptions session maxAge (7 days, refreshed on use).
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

export async function POST(request: Request) {
  // UUID guessing + JWT minting must be throttled: unlimited attempts would
  // let an attacker brute-force codes and mint sessions at will.
  const rl = checkRateLimit(`desktop-exchange:${clientIp(request)}`);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts — wait a minute" }, { status: 429 });
  }
  let code = "";
  try {
    code = String((await request.json())?.code || "");
  } catch {}
  // The app redeems the encrypted grant minted by the finish route. It is
  // self-contained (no server-side handle), so the exchange works even when
  // it lands on another serverless instance than the OAuth round-trip.
  const session = code ? readDesktopGrant(code) : null;
  if (!session?.id) {
    return NextResponse.json({ error: "Invalid or expired sign-in code" }, { status: 401 });
  }

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return NextResponse.json({ error: "NEXTAUTH_SECRET is not set" }, { status: 500 });

  const user = session;
  try {
    // Ensure a matching User row exists — FK-backed saves in the app would
    // otherwise fail on first write (mirrors /api/dev/session).
    await prisma.user.upsert({
      where: { id: user.id },
      update: { name: user.name ?? undefined, email: user.email ?? undefined },
      create: { id: user.id, name: user.name ?? "Orplex User", email: user.email },
    });

    // Sign a real next-auth JWT (same secret + derivation as the OAuth flow)
    // so getServerSession()/middleware accept it with zero changes.
    const token = await encode({
      token: {
        sub: user.id,
        id: user.id,
        name: user.name ?? null,
        email: user.email ?? null,
        picture: user.image ?? null,
        image: user.image ?? null,
      },
      secret,
      maxAge: SESSION_MAX_AGE,
    });

    const response = NextResponse.json({ ok: true, user: { id: user.id, email: user.email, name: user.name } });
    const base = { httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: SESSION_MAX_AGE };
    // The desktop app's origin is plain-HTTP loopback (http://localhost:5000).
    // A Secure cookie is only accepted there by browsers that treat loopback
    // as a secure context — and the local server must not depend on that:
    // drop Secure when the request was forwarded from a loopback host.
    const forwardedHost = (request.headers.get("x-forwarded-host") || "").toLowerCase();
    const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(forwardedHost);
    const secure = process.env.NODE_ENV === "production" && !loopback;
    response.cookies.set("next-auth.session-token", token, { ...base, secure });
    // Prefixed name: what NextAuth in production reads. Chromium accepts
    // Secure cookies on localhost, so this lands on the app's origin too.
    response.cookies.set("__Secure-next-auth.session-token", token, { ...base, secure: true });

    // The app's OWN session credential: Ed25519-signed by the backend and
    // verified locally with the shipped public key. The packaged app has no
    // NEXTAUTH_SECRET, so without this its page gate could not tell a
    // signed-in user from an anonymous one and bounced everyone to
    // /auth/signin right after a successful sign-in.
    const appToken = await signAppSession({
      id: user.id,
      name: user.name ?? null,
      email: user.email ?? null,
      image: user.image ?? null,
    });
    if (appToken) {
      response.cookies.set(APP_SESSION_COOKIE, appToken, { ...base, secure });
    }
    return response;
  } catch (error) {
    // Never log the full error object — it can contain the bearer code (in
    // request URLs) and DB internals. Message prefix only.
    console.error("[Desktop auth] exchange failed:", error instanceof Error ? error.message.slice(0, 200) : "unknown");
    return NextResponse.json({ error: "Failed to create the desktop session" }, { status: 500 });
  }
}
