import { NextRequest, NextResponse } from "next/server";
import { sessionUserId } from "@/lib/server-session";
import { getRecentChanges, computeDiff } from "@/lib/file-history";
import { publicErrorMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // Same two doors as every other local route: the Changes tab is rendered by
  // the desktop app, whose session is the Ed25519 cookie (not NextAuth).
  const userId = await sessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const changes = getRecentChanges(20);
    return NextResponse.json({
      changes: changes.map((c) => ({
        path: c.path,
        timestamp: c.timestamp,
        isNew: c.previousContent === null,
        diff: computeDiff(c.previousContent, c.newContent),
        lineCount: c.newContent.split("\n").length,
      })),
    });
  } catch (error) {
    return NextResponse.json({ changes: [], error: publicErrorMessage(error, "Internal server error") }, { status: 500 });
  }
}
