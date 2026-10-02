import { NextResponse } from "next/server";
import { encode } from "next-auth/jwt";
import { consumeDesktopCode } from "@/lib/desktop-auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

export async function POST(request: Request) {
  let code = "";
  try {
    code = String((await request.json())?.code || "");
  } catch {}
  const entry = code ? consumeDesktopCode(code) : null;
  if (!entry?.session?.id) {
    return NextResponse.json({ error: "Invalid or expired sign-in code" }, { status: 401 });
  }

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return NextResponse.json({ error: "NEXTAUTH_SECRET is not set" }, { status: 500 });

  const user = entry.session;
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
    // Plain name: what the app's Edge proxy check reads.
    response.cookies.set("next-auth.session-token", token, { ...base, secure: false });
    // Prefixed name: what NextAuth in production reads. Chromium accepts
    // Secure cookies on localhost, so this lands on the app's origin too.
    response.cookies.set("__Secure-next-auth.session-token", token, { ...base, secure: true });
    return response;
  } catch (error) {
    console.error("[Desktop auth] exchange failed:", error);
    return NextResponse.json({ error: "Failed to create the desktop session" }, { status: 500 });
  }
}
