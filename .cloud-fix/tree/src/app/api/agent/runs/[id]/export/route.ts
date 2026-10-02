import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { BUNDLE_FORMAT, chainEvents, buildManifestMd, clampArtifact, type AuditBundle } from "@/lib/audit-bundle";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/agent/runs/[id]/export — The flight recorder.
 *
 * One self-verifying bundle: run row, hash-chained lifecycle events, all
 * artifacts (bodies capped), tasks, approval decisions, and a human-readable
 * manifest.md. Ownership-checked. Generated on demand — nothing held in
 * memory between requests.
 */
export async function GET(_request: NextRequest, { params }: RouteContext) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const { id } = await params;
  const run = await prisma.agentRun.findFirst({ where: { id, userId: session.user.id } });
  if (!run) return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });

  const [events, artifacts, tasks, approvals] = await Promise.all([
    prisma.runEvent.findMany({
      where: { runId: id },
      orderBy: { sequence: "asc" },
      select: { sequence: true, type: true, payload: true, createdAt: true },
    }),
    prisma.agentArtifact.findMany({
      where: { runId: id },
      orderBy: { createdAt: "asc" },
      select: { kind: true, name: true, mediaType: true, content: true },
    }),
    prisma.agentTask.findMany({
      where: { runId: id },
      orderBy: { createdAt: "asc" },
      select: { id: true, role: true, status: true, title: true, createdAt: true },
    }),
    prisma.approvalRequest.findMany({
      where: { runId: id },
      orderBy: { createdAt: "asc" },
      select: { action: true, payload: true, status: true, decidedBy: true, decidedAt: true, createdAt: true },
    }),
  ]);

  const { events: chained, chainHead } = chainEvents(
    events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
  );

  const bundle: AuditBundle = {
    format: BUNDLE_FORMAT,
    exportedAt: new Date().toISOString(),
    run: JSON.parse(
      JSON.stringify({
        ...run,
        chainHead,
      }),
    ),
    events: chained,
    artifacts: artifacts.map((a) => {
      const clamped = clampArtifact(a.content);
      return { kind: a.kind, name: a.name, mediaType: a.mediaType, content: clamped.content, truncated: clamped.truncated || undefined };
    }),
    tasks,
    approvals,
    chainHead,
    manifestMd: "",
  };
  bundle.manifestMd = buildManifestMd(bundle.run, chained, approvals, chainHead);

  const total = bundle.artifacts.reduce((s, a) => s + a.content.length, 0) + bundle.manifestMd.length;
  if (total > 20 * 1024 * 1024) {
    // Never emit an oversized bundle — drop artifact bodies, keep the record.
    bundle.artifacts = bundle.artifacts.map((a) => ({
      ...a,
      content: a.content.slice(0, 10_000) + "\n\n[bundle size cap — artifact body removed]",
      truncated: true,
    }));
  }

  return NextResponse.json({ success: true, bundle });
}
