import { NextResponse } from "next/server";
import os from "os";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { RAM_THRESHOLDS } from "@/lib/hardware";

export const dynamic = "force-dynamic";

/**
 * GET /api/system/memory — one fresh RAM reading for failure messages.
 *
 * The watchdog's percentage lives server-side (os.freemem); the chat failure
 * path runs in the renderer and needs the number to explain a low-memory
 * failure. No secrets, no env values — a percentage and two MB figures.
 *
 * This is the ONLY /api route with no auth, and it is reachable by anything
 * that can reach the local port: it reports the host's RAM, which is enough to
 * fingerprint the machine and to time an attack for a memory-pressure DoS.
 * It sits on the local-only list precisely so it is served locally, which also
 * means nothing in front of it authenticates the caller.
 */
export async function GET() {
  const session = await getServerSession(jwtOnlyOptions).catch(() => null);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const totalBytes = os.totalmem() || 1;
  const freememBytes = os.freemem();
  const usedPercent = Math.round(
    Math.min(1, Math.max(0, 1 - freememBytes / totalBytes)) * 100
  );
  return NextResponse.json({
    usedPercent,
    lowMemory: usedPercent >= Math.round(RAM_THRESHOLDS.high * 100),
    freeMB: Math.round(freememBytes / 1048576),
    totalMB: Math.round(totalBytes / 1048576),
  });
}
