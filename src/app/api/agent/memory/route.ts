import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { listMemories, forgetMemory, retrieveWorkspaceMemories, formatMemoriesForPrompt, remember as rememberFact } from "@/lib/memory";
import { getWorkspaceKey } from "@/lib/memory";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent/memory?directoryName=... — list workspace learnings.
 * DELETE /api/agent/memory?id=... — forget one entry (user-controlled).
 *
 * directoryName is optional: the browser worker queries global tasks with no
 * workspace folder, which maps to the "(no-folder)" bucket via getWorkspaceKey
 * — a normal empty result, not a client error.
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const directoryName = request.nextUrl.searchParams.get("directoryName") || "";

  const workspaceKey = getWorkspaceKey(directoryName);
  const memories = await listMemories(workspaceKey);

  // The worker's per-task injection uses this endpoint too: when a `task`
  // query param is present, also return the scored + formatted block.
  const task = request.nextUrl.searchParams.get("task");
  let block: string | null = null;
  if (task) {
    const retrieved = await retrieveWorkspaceMemories(workspaceKey, task, 5).catch(() => []);
    block = formatMemoriesForPrompt(retrieved);
  }

  return NextResponse.json({
    success: true,
    workspaceKey,
    block,
    memories: memories.map((m) => ({
      id: m.id,
      kind: m.kind,
      content: m.content,
      files: m.files,
      count: m.count,
      firstSeenAt: m.firstSeenAt,
      lastSeenAt: m.lastSeenAt,
    })),
  });
}

/**
 * POST /api/agent/memory — /remember <fact>: pin a user-authored fact into
 * workspace memory (kind "decision", pinned — never stale-evicted, boosted
 * in retrieval). Body: { directoryName?, fact }.
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const directoryName = String(body?.directoryName ?? "");
  const fact = String(body?.fact ?? "").trim();
  if (!fact) {
    return NextResponse.json({ success: false, error: "fact required" }, { status: 400 });
  }
  if (fact.length > 500) {
    return NextResponse.json({ success: false, error: "fact too long (max 500 chars)" }, { status: 400 });
  }
  const workspaceKey = getWorkspaceKey(directoryName);
  const ok = await rememberFact(workspaceKey, fact);
  return NextResponse.json({ success: ok });
}

export async function DELETE(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const id = request.nextUrl.searchParams.get("id");
  const directoryName = request.nextUrl.searchParams.get("directoryName") || "";
  if (!id) {
    return NextResponse.json({ success: false, error: "id required" }, { status: 400 });
  }

  // Scope the delete to this workspace so one user cannot probe IDs across
  // workspaces (the id is not enumerable, but defense in depth is free).
  const workspaceKey = getWorkspaceKey(directoryName);
  const ok = await forgetMemory(id, workspaceKey);
  return NextResponse.json({ success: ok });
}
