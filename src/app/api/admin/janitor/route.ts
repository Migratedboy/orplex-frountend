import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { listSweepCandidates, runJanitor, getJanitorStatus } from "@/lib/janitor";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/janitor — list re-creatable artifacts the janitor MAY delete
 * (never deletes on GET) plus the last sweep result.
 */
export async function GET() {
  try {
    await requireAdmin();
    const [candidates, status] = await Promise.all([listSweepCandidates(), Promise.resolve(getJanitorStatus())]);
    return NextResponse.json({
      success: true,
      candidates,
      reclaimableBytes: candidates.filter((c) => !c.reason.includes("skipped")).reduce((s, c) => s + c.sizeBytes, 0),
      lastSweep: status,
    });
  } catch (err) {
    const status = err instanceof Error && err.message === "Unauthorized" ? 401 : err instanceof Error && err.message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : "Failed" }, { status });
  }
}

/**
 * POST /api/admin/janitor — run a sweep now. Body: { mode?: "full" | "critical" }.
 * Whitelist-only: only re-creatable caches, oversized logs, and >24h-orphaned
 * tmp worktrees are ever touched. Protected paths are refused at delete time.
 */
export async function POST(request: NextRequest) {
  try {
    await requireAdmin();
    const body = await request.json().catch(() => ({}));
    const mode = body?.mode === "critical" ? "critical" : "full";
    const result = await runJanitor({ mode });
    return NextResponse.json({ success: true, mode, result });
  } catch (err) {
    const status = err instanceof Error && err.message === "Unauthorized" ? 401 : err instanceof Error && err.message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : "Failed" }, { status });
  }
}
