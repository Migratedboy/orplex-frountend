import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { captureWorkspaceMemories, type CaptureInput } from "@/lib/memory";
import { getWorkspaceKey } from "@/lib/memory";

export const dynamic = "force-dynamic";

/**
 * POST /api/agent/memory/capture — Server-side write path for workspace
 * learnings. The browser worker reports what the run produced (files, lanes);
 * the SERVER derives and persists memories — the client never decides what is
 * worth remembering, and the DB is never touched from the browser.
 *
 * directoryName is optional: global tasks with no workspace folder land in
 * the "(no-folder)" bucket (deriveMemories derives nothing for them anyway
 * when they wrote no files — a normal no-op, not a client error).
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ success: false, error: "Invalid body" }, { status: 400 });
  }

  const directoryName = typeof body.directoryName === "string" ? body.directoryName : "";
  // No 400 on empty: "(no-folder)" is a legitimate bucket (global tasks).
  const input: CaptureInput = {
    workspaceKey: getWorkspaceKey(directoryName),
    task: typeof body.task === "string" ? body.task.slice(0, 500) : "",
    writtenFiles:
      body.writtenFiles && typeof body.writtenFiles === "object" && !Array.isArray(body.writtenFiles)
        ? Object.fromEntries(
            Object.entries(body.writtenFiles as Record<string, unknown>)
              .slice(0, 40)
              .map(([k, v]) => [k.slice(0, 300), typeof v === "string" ? v.slice(0, 20000) : ""])
          )
        : {},
    lanes: {
      typecheck: body.lanes?.typecheck === "pass" ? "pass" : body.lanes?.typecheck === "fail" ? "fail" : "skipped",
      browser: body.lanes?.browser === "pass" ? "pass" : body.lanes?.browser === "fail" ? "fail" : "skipped",
    },
    acceptedSuggestions: Array.isArray(body.acceptedSuggestions)
      ? body.acceptedSuggestions.filter((s: unknown): s is string => typeof s === "string").slice(0, 5)
      : [],
    rejectedSuggestions: Array.isArray(body.rejectedSuggestions)
      ? body.rejectedSuggestions.filter((s: unknown): s is string => typeof s === "string").slice(0, 5)
      : [],
    finalStatus: body.finalStatus === "done" ? "done" : "error",
  };

  const stored = await captureWorkspaceMemories(input).catch(() => 0);
  return NextResponse.json({ success: true, stored });
}
