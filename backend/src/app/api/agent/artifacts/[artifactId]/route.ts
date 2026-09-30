// Artifact detail + review API — the human verdict side of the review chain.
// GET: fetch one artifact (with its comments) for the review view
// PATCH: set review status (draft | reviewed | approved | rejected) + note.
//        Approving the last artifact of a run's chain is the "Approve & Merge"
//        moment — recorded as a run event so the timeline/agent can react.

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const ALLOWED_STATUSES = new Set(["draft", "reviewed", "approved", "rejected"]);

// === GET /api/agent/artifacts/:artifactId ===

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> }
) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { artifactId } = await params;

    const artifact = await prisma.agentArtifact.findUnique({
      where: { id: artifactId },
      include: { comments: { orderBy: { createdAt: "asc" } } },
    });

    if (!artifact) {
      return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
    }

    return NextResponse.json({ artifact });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch artifact" },
      { status: 500 }
    );
  }
}

// === PATCH /api/agent/artifacts/:artifactId ===

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> }
) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { artifactId } = await params;
    const body = await request.json();
    const { status, reviewNote } = body;

    if (typeof status !== "string" || !ALLOWED_STATUSES.has(status)) {
      return NextResponse.json(
        { error: `status must be one of: ${[...ALLOWED_STATUSES].join(", ")}` },
        { status: 400 }
      );
    }

    if (reviewNote !== undefined && reviewNote !== null && typeof reviewNote !== "string") {
      return NextResponse.json({ error: "reviewNote must be a string" }, { status: 400 });
    }

    const artifact = await prisma.agentArtifact.findUnique({
      where: { id: artifactId },
    });

    if (!artifact) {
      return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
    }

    const updated = await prisma.agentArtifact.update({
      where: { id: artifactId },
      data: {
        status,
        reviewNote: reviewNote === undefined ? artifact.reviewNote : reviewNote,
      },
    });

    // Record the verdict on the run's event log so the timeline and the
    // agent's next prompt can see the human's decision.
    await prisma.runEvent.create({
      data: {
        runId: artifact.runId,
        taskId: artifact.taskId || undefined,
        sequence: Date.now() % 100000,
        type: "artifact-review",
        payload: {
          artifactId,
          artifactKind: artifact.kind,
          artifactName: artifact.name,
          status,
          ...(reviewNote ? { note: reviewNote } : {}),
          userId: (session.user as any).id || "unknown",
        },
      },
    });

    // "Approve & Merge" signal: when every sequence-positioned artifact of
    // the run has been approved, surface a single merge-ready event.
    if (status === "approved") {
      const siblings = await prisma.agentArtifact.findMany({
        where: { runId: artifact.runId, sequence: { not: null } },
        select: { status: true },
      });
      const allApproved =
        siblings.length > 0 && siblings.every((a) => a.status === "approved");

      if (allApproved) {
        await prisma.runEvent.create({
          data: {
            runId: artifact.runId,
            taskId: artifact.taskId || undefined,
            sequence: (Date.now() % 100000) + 1,
            type: "artifact-chain-approved",
            payload: { runId: artifact.runId, count: siblings.length },
          },
        });
      }
    }

    return NextResponse.json({ artifact: updated });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to update artifact review" },
      { status: 500 }
    );
  }
}
