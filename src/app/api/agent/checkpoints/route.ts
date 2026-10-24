import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { getWorkspaceCwd } from "@/lib/workspace-cwd";
import { prisma } from "@/lib/prisma";
import { publicErrorMessage } from "@/lib/errors";
import {
  createCheckpoint,
  isGitRepo,
  listCheckpointsGit,
  listCheckpointsSnapshot,
  restoreCheckpointGit,
} from "@/lib/checkpoints";
import { safeJoinWorkspace } from "@/lib/workspace-history";
import { recordRuntimeLog } from "@/lib/runtime-log";

export const dynamic = "force-dynamic";

/** Ownership gate (pattern from runtime/service.ts assertRunOwner): true only
 * when the run exists AND belongs to the caller. Foreign/unknown runs → 404. */
async function ownsRun(runId: string, userId: string): Promise<boolean> {
  const run = await prisma.agentRun.findFirst({ where: { id: runId, userId }, select: { id: true } }).catch(() => null);
  return !!run;
}

/** GET /api/agent/checkpoints?runId=… — the run's checkpoint timeline. */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const runId = request.nextUrl.searchParams.get("runId");
  if (!runId) return NextResponse.json({ success: false, error: "runId required" }, { status: 400 });
  if (!(await ownsRun(runId, session.user.id))) {
    return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });
  }
  const rows = await prisma.runCheckpoint.findMany({
    where: { runId },
    orderBy: { sequence: "asc" },
  }).catch(() => []);
  return NextResponse.json({ success: true, checkpoints: rows });
}

/**
 * POST /api/agent/checkpoints — create one now.
 * Body: { runId, label?, changed?: [{path, created}] }.
 * Paths are workspace-relative; content comes from the workspace itself.
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const root = getWorkspaceCwd(session.user.id);
  if (!root) return NextResponse.json({ success: false, error: "no workspace" }, { status: 400 });
  const body = await request.json().catch(() => null);
  const runId = typeof body?.runId === "string" ? body.runId : "";
  if (!runId) return NextResponse.json({ success: false, error: "runId required" }, { status: 400 });
  if (!(await ownsRun(runId, session.user.id))) {
    return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });
  }
  const label = typeof body?.label === "string" ? body.label.slice(0, 120) : "manual";
  const changed = Array.isArray(body?.changed)
    ? body.changed
        .filter((c: unknown): c is { path: string; created?: boolean } =>
          !!c && typeof (c as { path?: unknown }).path === "string")
        .slice(0, 200)
        .map((c: { path: string; created?: boolean }) => ({
          path: c.path,
          abs: `${root}/${c.path}`,
          created: c.created === true,
        }))
        .filter((c: { path: string; abs: string; created: boolean }) => {
          // Containment: snapshot kind copies abs→dir on non-git workspaces —
          // an escaping path would read/copy arbitrary files. Git workspaces
          // ignore `changed` (uses workingTreeFiles), same gate applies.
          if (!safeJoinWorkspace(root, c.path)) return false;
          return true;
        })
    : [];
  if (Array.isArray(body?.changed) && body.changed.length > 0 && changed.length === 0) {
    return NextResponse.json({ success: false, error: "path escapes workspace" }, { status: 403 });
  }

  try {
    const result = await createCheckpoint(root, runId, label, changed);
    const sequence = result.n >= 0 ? result.n : 0;
    await prisma.runCheckpoint.create({
      data: { runId, sequence, kind: result.kind, ref: result.ref, label: result.label, filesCount: result.files.length },
    }).catch(() => {});
    recordRuntimeLog("workspace", "info", `checkpoint ${result.id} (${result.kind}) — ${result.files.length} file(s)`);
    return NextResponse.json({ success: true, checkpoint: { id: result.id, kind: result.kind, ref: result.ref, label: result.label, files: result.files.length } });
  } catch (err) {
    return NextResponse.json({ success: false, error: publicErrorMessage(err, "Checkpoint failed") }, { status: 400 });
  }
}

/**
 * PUT /api/agent/checkpoints — restore.
 * Body: { runId, sequence } (or { ref } for a raw git ref).
 * Conversation rows after the checkpoint are archived (never destroyed).
 */
export async function PUT(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const root = getWorkspaceCwd(session.user.id);
  if (!root) return NextResponse.json({ success: false, error: "no workspace" }, { status: 400 });
  const body = await request.json().catch(() => null);
  const runId = typeof body?.runId === "string" ? body.runId : "";
  const sequence = typeof body?.sequence === "number" ? body.sequence : null;
  if (!runId || sequence === null) {
    return NextResponse.json({ success: false, error: "runId and sequence required" }, { status: 400 });
  }
  if (!(await ownsRun(runId, session.user.id))) {
    return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });
  }
  const cp = await prisma.runCheckpoint.findUnique({
    where: { runId_sequence: { runId, sequence } },
  }).catch(() => null);
  if (!cp) return NextResponse.json({ success: false, error: "checkpoint not found" }, { status: 404 });

  try {
    if (cp.kind !== "git") {
      return NextResponse.json({ success: false, error: "snapshot restore happens file-by-file from the manifest — use undo/history for chat-mode" }, { status: 400 });
    }
    if (!(await isGitRepo(root))) {
      return NextResponse.json({ success: false, error: "workspace is no longer a git repo" }, { status: 400 });
    }
    await restoreCheckpointGit(root, cp.ref, runId);

    // Run-event rewind: events after the checkpoint are archived (never
    // destroyed — parked on the run's `archived` blob). Message rewind rides
    // the checkpoint-restored event client-side (runs have no conversation
    // relation; the chat UI folds messages after this event's timestamp).
    const cutoff = cp.createdAt;
    const evts = await prisma.runEvent.findMany({ where: { runId, createdAt: { gt: cutoff } }, select: { id: true } }).catch(() => [] as { id: string }[]);
    if (evts.length > 0) {
      const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { archived: true } }).catch(() => null);
      const prevArchive = (run?.archived as { events?: string[] } | null) ?? {};
      await prisma.agentRun.update({
        where: { id: runId },
        data: {
          archived: { ...(prevArchive as object), events: [...(prevArchive.events ?? []), ...evts.map((e) => e.id)] },
        },
      }).catch(() => {});
    }
    const lastEvent = await prisma.runEvent.findFirst({ where: { runId }, orderBy: { sequence: "desc" }, select: { sequence: true } }).catch(() => null);
    await prisma.runEvent.create({
      data: { runId, sequence: (lastEvent?.sequence ?? 0) + 1, type: "checkpoint-restored", payload: { sequence, ref: cp.ref, eventsArchived: evts.length } },
    }).catch(() => {});
    recordRuntimeLog("workspace", "info", `checkpoint restore ${runId}/${sequence} — ${evts.length} event(s) archived`);
    return NextResponse.json({ success: true, restored: { sequence, ref: cp.ref }, archivedEvents: evts.length, restoredAt: cutoff.toISOString() });
  } catch (err) {
    return NextResponse.json({ success: false, error: publicErrorMessage(err, "Checkpoint restore failed") }, { status: 400 });
  }
}
