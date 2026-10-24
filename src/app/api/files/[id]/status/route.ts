// Status read for a staged in-memory file. The card calls this after an app
// restart (store wiped) or to refresh a stale card, and renders the honest
// state: live | expired | removed. Never an error.
import { NextRequest, NextResponse } from "next/server";
import { sessionUserId } from "@/lib/server-session";
import { memoryFileStatus } from "@/lib/memory-file-store";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await sessionUserId(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: raw } = await params;
    // Same shape check as the content route (see its comment).
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(raw || "")) {
      return NextResponse.json({ error: "Invalid file id" }, { status: 400 });
    }

    return NextResponse.json({
      state: memoryFileStatus(raw),
    });
  } catch {
    return NextResponse.json({ error: "Failed to check staged file" }, { status: 500 });
  }
}
