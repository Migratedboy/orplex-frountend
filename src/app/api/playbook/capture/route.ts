import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { deriveFromRun, mergeOrCreate } from "@/lib/playbook";

export const dynamic = "force-dynamic";

/**
 * POST /api/playbook/capture — Server-side write path for playbook learnings.
 * The browser worker (via the pattern-learner plugin) reports what the run
 * produced (task, files, lanes); the SERVER derives evidence-gated entries
 * and merges them — the client never decides what is worth remembering, and
 * the DB is never touched from the browser.
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

  const lanes = (body.lanes && typeof body.lanes === "object" ? body.lanes : {}) as Record<string, unknown>;
  const files =
    body.files && typeof body.files === "object" && !Array.isArray(body.files)
      ? Object.fromEntries(
          Object.entries(body.files as Record<string, unknown>)
            .slice(0, 40)
            .map(([k, v]) => [k.slice(0, 300), typeof v === "string" ? v.slice(0, 20000) : ""])
        )
      : {};

  const derived = deriveFromRun({
    task: typeof body.task === "string" ? body.task.slice(0, 500) : "",
    files,
    lanes: {
      typecheck: lanes.typecheck === "pass" ? "pass" : lanes.typecheck === "fail" ? "fail" : undefined,
      browser: lanes.browser === "pass" ? "pass" : lanes.browser === "fail" ? "fail" : undefined,
      swarm: lanes.swarm === "pass" ? "pass" : lanes.swarm === "fail" ? "fail" : undefined,
    },
    finalStatus: body.finalStatus === "done" ? "done" : "error",
  });

  let stored = 0;
  for (const entry of derived) {
    const saved = await mergeOrCreate(session.user.id, entry).catch(() => null);
    if (saved) stored++;
  }

  return NextResponse.json({ success: true, stored });
}
