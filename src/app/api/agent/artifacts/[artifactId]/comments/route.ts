// Comments API — inline feedback on agent artifacts
// GET: list comments for an artifact
// POST: add comment to artifact (included in agent's next LLM call)

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// === GET /api/agent/artifacts/:artifactId/comments ===

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> }
) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    // NOTE: check .id, not just .user — a session without an id would make
    // `where: { run: { userId: undefined } }` skip the filter and match ANY
    // run, silently bypassing the ownership gate below.
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { artifactId } = await params;
    const userId = session.user.id;

    // Ownership gate: artifacts belong to runs belong to users. Without
    // this any logged-in user could read anyone's artifact comments.
    const owned = await prisma.agentArtifact.findFirst({
      where: { id: artifactId, run: { userId } },
      select: { id: true },
    });
    if (!owned) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const comments = await prisma.comment.findMany({
      where: { artifactId },
      orderBy: { createdAt: "asc" },
    });

    return NextResponse.json({ comments });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch comments" },
      { status: 500 }
    );
  }
}

// === POST /api/agent/artifacts/:artifactId/comments ===

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> }
) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { artifactId } = await params;
    const userId = session.user.id;
    const body = await request.json().catch(() => null);
    const content = typeof body?.content === "string" ? body.content.trim().slice(0, 2000) : "";

    if (!content) {
      return NextResponse.json(
        { error: "Comment content is required" },
        { status: 400 }
      );
    }

    // Anchors are optional; when present they must be 0–1 fractions (they
    // position a pin on a screenshot artifact, so out-of-range = bad client).
    const validAnchor = (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

    // Verify artifact exists AND belongs to this user (same gate as GET —
    // otherwise anyone could comment into anyone's run event log).
    const artifact = await prisma.agentArtifact.findFirst({
      where: { id: artifactId, run: { userId } },
    });

    if (!artifact) {
      return NextResponse.json(
        { error: "Artifact not found" },
        { status: 404 }
      );
    }

    // Create the comment (with optional pin position for visual annotations)
    const hasAnchor = validAnchor(body?.anchorX) && validAnchor(body?.anchorY);
    const anchorX = body?.anchorX;
    const anchorY = body?.anchorY;
    const comment = await prisma.comment.create({
      data: {
        artifactId,
        userId,
        content,
        ...(hasAnchor ? { anchorX, anchorY } : {}),
      },
    });

    // Also append to the artifact's run event log for agent context.
    // sequence has a @@unique([runId, sequence]) constraint and
    // Date.now() % 100000 collides under concurrency — retry with a bump.
    const baseSeq = Date.now() % 100000;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await prisma.runEvent.create({
          data: {
            runId: artifact.runId,
            taskId: artifact.taskId || undefined,
            sequence: (baseSeq + attempt) % 100000,
            type: "comment",
            payload: {
              artifactId,
              commentId: comment.id,
              content,
              ...(hasAnchor ? { anchorX, anchorY } : {}),
              userId,
            },
          },
        });
        break;
      } catch (err) {
        if ((err as { code?: string })?.code !== "P2002" || attempt === 2) throw err;
      }
    }

    return NextResponse.json({ comment }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to create comment" },
      { status: 500 }
    );
  }
}
