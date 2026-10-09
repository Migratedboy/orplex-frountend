import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { getPendingApprovals, approveRequest, rejectRequest } from "@/lib/approval-store";

export const dynamic = "force-dynamic";

// NOTE on ownership: this store is the BROWSER lane's in-memory approvals —
// the worker, the store, and the dialog all run in the same tab/realm, so
// entries are inherently per-user (per-machine in the desktop app). Server
// runs never touch it: they gate through DB ApprovalRequest rows decided via
// /api/agent/runs/[id]/approve, which IS ownership-scoped (run.userId). On a
// shared backend this route's store is always empty. There is therefore no
// cross-user decision to steal here; the hardening below (strict id/action
// types, no error leaks) is defense-in-depth.
function readId(id: unknown): string | null {
  return typeof id === "string" && id.length > 0 && id.length <= 128 ? id : null;
}

// GET: Poll for pending approvals
export async function GET() {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const approvals = getPendingApprovals();
    return NextResponse.json({ approvals });
  } catch (error) {
    console.error("[approve GET]", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Failed to list approvals" }, { status: 500 });
  }
}

// POST: Approve or reject a specific request
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = await request.json().catch(() => null);
    const id = body && typeof body === "object" ? readId((body as { id?: unknown }).id) : null;
    const action = body && typeof body === "object" ? (body as { action?: unknown }).action : undefined;
    if (!id || (action !== "approve" && action !== "reject")) {
      return NextResponse.json({ error: "id (string) and action (approve|reject) required" }, { status: 400 });
    }
    const ok = action === "approve" ? approveRequest(id) : rejectRequest(id);
    return NextResponse.json({ success: ok });
  } catch (error) {
    console.error("[approve POST]", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Failed to decide approval" }, { status: 500 });
  }
}
