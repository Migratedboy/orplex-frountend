import { NextResponse } from "next/server";
import { clearedSessionResponse } from "@/lib/session-cookies";

export const dynamic = "force-dynamic";

/**
 * Local-only sign-out complement: expires EVERY session credential this app
 * mints (NextAuth's token in both prefixed/unprefixed forms, plus the desktop
 * app's Ed25519 session). Registered as a LOCAL_ONLY route in proxy.ts so it
 * runs on the app origin even in split mode — /api/auth/* is proxied to the
 * backend, which cannot clear cookies scoped to this origin's extra names.
 *
 * The client still calls NextAuth's signOut() to clear server-managed auth
 * state/callback cookies; this route guarantees the desktop/app credentials
 * that NextAuth doesn't own are also dropped, fixing account-A lingering after
 * switching to account B.
 */
export async function POST() {
  return clearedSessionResponse({ ok: true });
}

export async function GET() {
  return clearedSessionResponse({ ok: true });
}
