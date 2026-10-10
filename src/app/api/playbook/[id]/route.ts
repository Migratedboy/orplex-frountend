import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { updatePlaybook, deletePlaybook } from "@/lib/playbook";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    // Mirror POST validation: wrong types must 400, never reach Prisma.
    const { content, pinned, tags } = body as Record<string, unknown>;
    if (content !== undefined && typeof content !== "string") {
      return NextResponse.json({ error: "content must be a string" }, { status: 400 });
    }
    if (pinned !== undefined && typeof pinned !== "boolean") {
      return NextResponse.json({ error: "pinned must be a boolean" }, { status: 400 });
    }
    if (tags !== undefined && (!Array.isArray(tags) || !tags.every((t) => typeof t === "string"))) {
      return NextResponse.json({ error: "tags must be string[]" }, { status: 400 });
    }
    if (content === undefined && pinned === undefined && tags === undefined) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    const updated = await updatePlaybook(id, session.user.id, {
      ...(content !== undefined && { content: content as string }),
      ...(pinned !== undefined && { pinned: pinned as boolean }),
      ...(tags !== undefined && { tags: tags as string[] }),
    });

    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ entry: updated });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const deleted = await deletePlaybook(id, session.user.id);

    if (!deleted) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}
