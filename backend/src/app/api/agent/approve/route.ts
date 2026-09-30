import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { getPendingApprovals, approveRequest, rejectRequest } from "@/lib/approval-store";

export const dynamic = "force-dynamic";

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
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

// POST: Approve or reject a specific request
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id, action } = await request.json();
    if (!id || !action) {
      return NextResponse.json({ error: "Missing id or action" }, { status: 400 });
    }
    if (action === "approve") {
      const ok = approveRequest(id);
      return NextResponse.json({ success: ok });
    } else if (action === "reject") {
      const ok = rejectRequest(id);
      return NextResponse.json({ success: ok });
    }
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
