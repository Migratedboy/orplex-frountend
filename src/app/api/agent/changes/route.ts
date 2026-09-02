import { NextResponse } from "next/server";
import { getRecentChanges, computeDiff } from "@/lib/file-history";

export const dynamic = "force-dynamic";

export async function GET() {
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
    return NextResponse.json({ changes: [], error: (error as Error).message }, { status: 500 });
  }
}
