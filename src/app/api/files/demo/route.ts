// Dev-only demo seeds for the staging card's three render states (live /
// Expired / Removed). Production refuses — the demo gate is enforced inside
// seedDemoMemoryFileStates and again here so a dev route can never be tricked.
import { NextRequest, NextResponse } from "next/server";
import { sessionUserId } from "@/lib/server-session";
import { seedDemoMemoryFileStates } from "@/lib/memory-file-store";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const userId = await sessionUserId(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const dev = process.env.NODE_ENV !== "production";
    return NextResponse.json({
      demo: seedDemoMemoryFileStates(dev),
    });
  } catch {
    return NextResponse.json({ error: "Failed to seed demo states" }, { status: 500 });
  }
}
