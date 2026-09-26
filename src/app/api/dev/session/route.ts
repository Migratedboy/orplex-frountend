import { NextResponse } from "next/server";
import { encode } from "next-auth/jwt";

export const dynamic = "force-dynamic";

const DEV_USER_ID = "dev-user";
const DEV_USER_EMAIL = "dev@orplex.local";
const DEV_USER_NAME = "Dev User";
// Seconds — must match authOptions session maxAge (30 days).
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
// Cookie name is unprefixed outside production, where next-auth runs over
// http and uses "next-auth.session-token" (no __Secure- prefix).
const SESSION_COOKIE = "next-auth.session-token";

/**
 * Development-only session bypass gate.
 *
 * Enabled whenever NODE_ENV is NOT "production" (i.e. `next dev` / test runs),
 * so the chat flow can be E2E-tested without real Google/GitHub credentials.
 * Set DEV_AUTH_BYPASS=false (or 0) in .env to force-disable even in dev.
 * Any deployed build runs with NODE_ENV=production, so this route can never
 * be used against a real deployment.
 */
export function isDevBypassEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const override = process.env.DEV_AUTH_BYPASS;
  if (override === "0" || override === "false" || override === "FALSE") return false;
  return true;
}

export async function GET(request: Request) {
  const enabled = isDevBypassEnabled();
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  // Plain probe (no action): lets the sign-in page decide whether to show the
  // dev-login/dev-logout controls. Returns 200 with { enabled: false } so the
  // client doesn't need to special-case a 404.
  if (!action) {
    return NextResponse.json({ enabled });
  }

  if (!enabled) {
    return NextResponse.json({ error: "Dev session bypass is disabled" }, { status: 404 });
  }

  // Log out: expire the dev session cookie so testers can end the dev session
  // and sign in again under a different (real OAuth) identity. The cookie is
  // httpOnly, so only the server can clear it — mirror the exact attributes
  // used when the cookie was issued. Reports whether a valid session existed
  // so the UI can show an accurate confirmation.
  if (action === "logout") {
    let hadSession = false;
    try {
      const cookieHeader = request.headers.get("cookie") || "";
      const pair = cookieHeader
        .split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
      if (pair && process.env.NEXTAUTH_SECRET) {
        const { decode } = await import("next-auth/jwt");
        const token = await decode({
          token: pair.slice(SESSION_COOKIE.length + 1),
          secret: process.env.NEXTAUTH_SECRET,
        });
        hadSession = !!token;
      }
    } catch {
      // Treat decode failure as "no active session" — the clear below still runs.
    }

    const response = NextResponse.json({ ok: true, hadSession });
    response.cookies.set(SESSION_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
      expires: new Date(0),
      secure: false,
    });
    return response;
  }

  // Seed: create/refresh sample data for the dev user (conversations,
  // workspace, quota usage) so E2E tests and manual dev sessions start from
  // non-empty UI states. Lazy import keeps prisma off the probe/login path.
  if (action === "seed") {
    try {
      const { seedDevData } = await import("@/lib/dev-seed");
      const summary = await seedDevData();
      return NextResponse.json(summary);
    } catch (error) {
      console.error("[Dev session] failed to seed dev data:", error);
      const msg = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: `Failed to seed dev data: ${msg}` }, { status: 500 });
    }
  }

  if (action !== "login") {
    return NextResponse.json({ enabled });
  }

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "NEXTAUTH_SECRET is not set" }, { status: 500 });
  }

  try {
    // Ensure a matching User row exists — Conversation/AgentRun/WorkspaceMember
    // rows all have FK constraints back to users, so a session without a DB
    // user would fail on the first save.
    // Lazy import so the route never touches Prisma unless the bypass fires.
    const { prisma } = await import("@/lib/prisma");
    await prisma.user.upsert({
      where: { id: DEV_USER_ID },
      update: { name: DEV_USER_NAME, email: DEV_USER_EMAIL },
      create: { id: DEV_USER_ID, name: DEV_USER_NAME, email: DEV_USER_EMAIL },
    });

    // Sign a real next-auth JWT using the library's own encode() (same secret
    // + HS256/HKDF derivation as the OAuth flow), so getServerSession() in API
    // routes and withAuth in the middleware accept the cookie with zero
    // changes to per-route auth code.
    const token = await encode({
      token: {
        sub: DEV_USER_ID,
        id: DEV_USER_ID,
        name: DEV_USER_NAME,
        email: DEV_USER_EMAIL,
        picture: null,
        image: null,
      },
      secret,
      maxAge: SESSION_MAX_AGE,
    });

    const response = NextResponse.json({ ok: true, user: { id: DEV_USER_ID, email: DEV_USER_EMAIL } });
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE,
      secure: false,
    });
    return response;
  } catch (error) {
    console.error("[Dev session] failed to create dev session:", error);
    return NextResponse.json({ error: "Failed to create dev session" }, { status: 500 });
  }
}
