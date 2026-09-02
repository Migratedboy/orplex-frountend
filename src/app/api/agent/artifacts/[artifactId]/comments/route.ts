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
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { artifactId } = await params;

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
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { artifactId } = await params;
    const body = await request.json();
    const { content } = body;

    if (!content || typeof content !== "string" || content.trim().length === 0) {
      return NextResponse.json(
        { error: "Comment content is required" },
        { status: 400 }
      );
    }

    // Verify artifact exists
    const artifact = await prisma.agentArtifact.findUnique({
      where: { id: artifactId },
    });

    if (!artifact) {
      return NextResponse.json(
        { error: "Artifact not found" },
        { status: 404 }
      );
    }

    // Create the comment
    const comment = await prisma.comment.create({
      data: {
        artifactId,
        userId: (session.user as any).id || "unknown",
        content: content.trim(),
      },
    });

    // Also append to the artifact's run event log for agent context
    await prisma.runEvent.create({
      data: {
        runId: artifact.runId,
        taskId: artifact.taskId || undefined,
        sequence: Date.now() % 100000,
        type: "comment",
        payload: {
          artifactId,
          commentId: comment.id,
          content: content.trim(),
          userId: (session.user as any).id || "unknown",
        },
      },
    });

    return NextResponse.json({ comment }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to create comment" },
      { status: 500 }
    );
  }
}
