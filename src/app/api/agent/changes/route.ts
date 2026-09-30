import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { getRecentChanges, computeDiff } from "@/lib/file-history";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
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
    return NextResponse.json({ changes: [], error: (error as Error).message }, { status: 500 });
  }
}
