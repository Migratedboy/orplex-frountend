import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { verifyBundle, type AuditBundle } from "@/lib/audit-bundle";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/agent/runs/[id]/export/verify — Recompute the hash chain of a
 * previously exported bundle. Body: the bundle JSON itself (any origin —
 * the verifier is pure, the endpoint just runs it). The run id in the path
 * must belong to the caller, so the endpoint can't be used to probe run ids;
 * verification itself needs no DB access.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const { id } = await params;
  const { prisma } = await import("@/lib/prisma");
  const owned = await prisma.agentRun.findFirst({ where: { id, userId: session.user.id }, select: { id: true } });
  if (!owned) return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  const bundle = (body as { bundle?: AuditBundle } | null)?.bundle ?? (body as AuditBundle | null);
  if (!bundle || typeof bundle !== "object" || !Array.isArray(bundle.events)) {
    return NextResponse.json({ success: false, error: "bundle JSON with events[] required" }, { status: 400 });
  }

  const result = verifyBundle(bundle);
  return NextResponse.json({ success: true, valid: result.valid, reason: result.reason });
}
