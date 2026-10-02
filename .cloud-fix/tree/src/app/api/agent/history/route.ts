import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { getWorkspaceCwd } from "@/lib/workspace-cwd";
import {
  appendHistory,
  readHistory,
  findUndoTarget,
  inverseOf,
  machineId,
} from "@/lib/workspace-history";
import { readFile, writeFile } from "node:fs/promises";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB per record request

/**
 * POST /api/agent/history — record one file change durably.
 * Body: { path, prev, next, t? }. Fire-and-forget from the browser; failures
 * here must never break the write path, hence the plain error envelope.
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const root = getWorkspaceCwd(session.user.id);
  if (!root) {
    // No workspace open — nothing durable to record against.
    return NextResponse.json({ success: false, error: "no workspace" }, { status: 400 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body.path !== "string" || typeof body.next !== "string") {
    return NextResponse.json({ success: false, error: "path and next required" }, { status: 400 });
  }
  if (body.next.length > 400_000 || (body.prev != null && body.prev.length > 400_000)) {
    return NextResponse.json({ success: true, recorded: false, reason: "too-large" });
  }
  const ok = await appendHistory(root, {
    path: body.path,
    prev: typeof body.prev === "string" ? body.prev : null,
    next: body.next,
    t: typeof body.t === "number" ? body.t : undefined,
    peer: "browser",
  }).catch(() => false);
  return NextResponse.json({ success: true, recorded: ok });
}

/**
 * GET /api/agent/history?since=<epochMs> — entries newest-first for hydrate.
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const root = getWorkspaceCwd(session.user.id);
  if (!root) return NextResponse.json({ success: true, entries: [] });
  const sinceRaw = request.nextUrl.searchParams.get("since");
  const since = sinceRaw ? Number(sinceRaw) : undefined;
  const entries = await readHistory(root, Number.isFinite(since) ? since : undefined);
  return NextResponse.json({ success: true, entries: entries.reverse() });
}

/**
 * PUT /api/agent/history — undo: body { path, current? }. Applies the newest
 * matching entry's prev content to the file, records the inverse entry, and
 * returns the content for the browser to apply locally too.
 */
export async function PUT(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const root = getWorkspaceCwd(session.user.id);
  if (!root) return NextResponse.json({ success: false, error: "no workspace" }, { status: 400 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body.path !== "string") {
    return NextResponse.json({ success: false, error: "path required" }, { status: 400 });
  }

  const entries = await readHistory(root);
  let current: string | null = null;
  try {
    current = await readFile(`${root}/${body.path}`, "utf8");
  } catch {
    current = null;
  }
  const target = findUndoTarget(entries, body.path, typeof body.current === "string" ? body.current : current);
  if (!target) {
    return NextResponse.json({ success: false, error: "no undo entry" }, { status: 404 });
  }
  // Undoing a file creation = delete; represent by writing empty is wrong, so
  // only restore when prev exists; creations are reported as "delete-file".
  if (target.prev === null) {
    return NextResponse.json({ success: true, action: "delete-file", path: target.path });
  }
  await writeFile(`${root}/${target.path}`, target.prev, "utf8");
  await appendHistory(root, inverseOf(target, machineId()));
  return NextResponse.json({ success: true, action: "restored", path: target.path, content: target.prev });
}
