// /api/cron/reset — serverless-safe daily quota reset (Vercel Cron Jobs).
//
// In-process timers don't survive on serverless, so Vercel Cron hits this
// route at midnight UTC instead. Auth: `Authorization: Bearer <CRON_SECRET>`
// (Vercel injects it automatically when the cron uses the secret). The
// advisory lock inside runDailyReset() keeps concurrent/manual triggers safe.
// Local/desktop installs don't need this route (in-process timer covers them)
// but it works anywhere when CRON_SECRET is set.

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { runDailyReset } from "@/lib/cron-reset";

export const dynamic = "force-dynamic";

/** Constant-time bearer compare (length check first — unequal lengths fail closed). */
function bearerMatches(header: string, secret: string): boolean {
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Cron not configured" }, { status: 503 });
  }
  const auth = request.headers.get("authorization") || "";
  if (!bearerMatches(auth, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { ran } = await runDailyReset();
    return NextResponse.json({ ok: true, ran });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : "reset failed" },
      { status: 500 }
    );
  }
}
