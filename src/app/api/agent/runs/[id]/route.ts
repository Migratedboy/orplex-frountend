import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { cancelRuntimeRun, getRuntimeRun } from "@/lib/agent/runtime";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const { id } = await params;
  const run = await getRuntimeRun(session.user.id, id);
  if (!run) return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });
  return NextResponse.json({ success: true, run });
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const { id } = await params;
  try {
    await cancelRuntimeRun(session.user.id, id);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });
  }
}