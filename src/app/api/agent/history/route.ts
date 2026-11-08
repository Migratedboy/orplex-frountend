import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { getWorkspaceCwd } from "@/lib/workspace-cwd";
import {
  appendHistory,
  appendKeepMarkers,
  getPendingHistoryChanges,
  readHistory,
  findUndoTarget,
  inverseOf,
  machineId,
  safeJoinWorkspace,
} from "@/lib/workspace-history";
import { assertSafeWrite } from "@/lib/reliability/path-jail";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 20 * 1024 * 1024; // snapshots include both previous and next content

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
  if (!body || typeof body !== "object") {
    return NextResponse.json({ success: false, error: "invalid history request" }, { status: 400 });
  }
  try {
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json({ success: false, error: "request too large" }, { status: 413 });
    }
  } catch {
    return NextResponse.json({ success: false, error: "invalid body" }, { status: 400 });
  }
  if (body.action === "keep") {
    const paths = Array.isArray(body.paths)
      ? body.paths.filter((path: unknown): path is string => typeof path === "string")
      : typeof body.path === "string" ? [body.path] : [];
    if (!paths.length || (Array.isArray(body.paths) && paths.length !== body.paths.length)) {
      return NextResponse.json({ success: false, error: "path or paths required" }, { status: 400 });
    }
    for (const path of paths) {
      const safe = await assertSafeWrite(root, path);
      if (!safe.ok) return NextResponse.json({ success: false, error: safe.reason }, { status: 403 });
    }
    try {
      const recorded = await appendKeepMarkers(root, paths, "browser");
      if (!recorded) return NextResponse.json({ success: false, error: "could not record Keep" }, { status: 400 });
      return NextResponse.json({ success: true, kept: paths });
    } catch (error) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "could not record Keep" }, { status: 500 });
    }
  }
  if (
    typeof body.path !== "string" ||
    (body.prev !== null && typeof body.prev !== "string") ||
    (body.next !== null && typeof body.next !== "string")
  ) {
    return NextResponse.json({ success: false, error: "path, prev, and next are required" }, { status: 400 });
  }
  // Containment: reject paths escaping the workspace root.
  const safe = await assertSafeWrite(root, body.path);
  if (!safe.ok || !safeJoinWorkspace(root, body.path)) {
    return NextResponse.json({ success: false, error: safe.ok ? "path escapes workspace" : safe.reason }, { status: 403 });
  }
  if ((body.next?.length ?? 0) > 2_000_000 || (body.prev != null && body.prev.length > 2_000_000)) {
    return NextResponse.json({ success: false, recorded: false, reason: "snapshot-too-large" }, { status: 413 });
  }
  const ok = await appendHistory(root, {
    path: body.path,
    prev: typeof body.prev === "string" ? body.prev : null,
    next: typeof body.next === "string" ? body.next : null,
    t: typeof body.t === "number" ? body.t : undefined,
    peer: "browser",
    encoding: body.encoding === "base64" ? "base64" : "utf8",
  }).catch(() => false);
  return NextResponse.json({ success: ok, recorded: ok }, { status: ok ? 200 : 413 });
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
  if (!root) return NextResponse.json({ success: true, entries: [], files: [] });
  if (request.nextUrl.searchParams.get("view") === "pending") {
    const history = await readHistory(root);
    const pending = getPendingHistoryChanges(history);
    const files = [];
    for (const item of pending) {
      const safe = await assertSafeWrite(root, item.path);
      if (!safe.ok) continue;
      const full = safeJoinWorkspace(root, item.path);
      if (!full) continue;
      let bytes: Buffer | null = null;
      try {
        bytes = await readFile(full);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const binary = item.encoding === "base64" ||
        (!!bytes && (bytes.includes(0) || bytes.toString("utf8").includes("\uFFFD")));
      const current = bytes === null
        ? null
        : item.encoding === "base64" || binary
          ? bytes.toString("base64")
          : bytes.toString("utf8");
      const before = item.prev === null
        ? null
        : item.encoding === "base64"
          ? item.prev
          : item.prev;
      const expected = item.next;
      if (!binary && before === current) continue;
      files.push({
        path: item.path,
        before,
        current,
        expected,
        encoding: item.encoding,
        binary,
        kind: before === null ? "new" : current === null ? "deleted" : "edit",
        changedSinceWrite: current !== expected,
      });
    }
    return NextResponse.json({ success: true, files });
  }
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
  if (!body || typeof body !== "object") {
    return NextResponse.json({ success: false, error: "invalid request" }, { status: 400 });
  }
  if (body.action === "undo-pending") {
    return undoPending(root, body);
  }
  if (typeof body.path !== "string") {
    return NextResponse.json({ success: false, error: "path required" }, { status: 400 });
  }
  try {
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json({ success: false, error: "request too large" }, { status: 413 });
    }
  } catch {
    return NextResponse.json({ success: false, error: "invalid body" }, { status: 400 });
  }
  const safe = await assertSafeWrite(root, body.path);
  const safePath = safeJoinWorkspace(root, body.path);
  if (!safe.ok || !safePath) {
    return NextResponse.json({ success: false, error: safe.ok ? "path escapes workspace" : safe.reason }, { status: 403 });
  }

  const entries = await readHistory(root);
  let current: string | null = null;
  try {
    current = await readFile(safePath, "utf8");
  } catch {
    current = null;
  }
  const target = findUndoTarget(entries, body.path, current);
  if (!target) {
    return NextResponse.json({ success: false, error: "no undo entry" }, { status: 404 });
  }
  // Undoing a file creation = delete; represent by writing empty is wrong, so
  // only restore when prev exists; creations are reported as "delete-file".
  if (target.prev === null) {
    try {
      await rm(safePath, { force: true });
      const logged = await appendHistory(root, inverseOf(target, machineId()));
      if (!logged) throw new Error("could not save the inverse history entry");
    } catch (error) {
      try {
        await mkdir(dirname(safePath), { recursive: true });
        await writeFile(safePath, target.next ?? "", "utf8");
      } catch (rollbackError) {
        return NextResponse.json({
          success: false,
          error: `Undo failed: ${error instanceof Error ? error.message : String(error)}; could not restore the created file: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        }, { status: 500 });
      }
      return NextResponse.json({ success: false, error: "Undo failed; the created file was restored and history is unchanged." }, { status: 500 });
    }
    return NextResponse.json({ success: true, action: "delete-file", path: target.path });
  }
  const targetSafe = await assertSafeWrite(root, target.path);
  const targetFull = safeJoinWorkspace(root, target.path);
  if (!targetSafe.ok || !targetFull) {
    return NextResponse.json({ success: false, error: targetSafe.ok ? "stored path escapes workspace" : targetSafe.reason }, { status: 403 });
  }
  await writeFile(targetFull, target.prev, "utf8");
  try {
    const logged = await appendHistory(root, inverseOf(target, machineId()));
    if (!logged) throw new Error("could not save the inverse history entry");
  } catch (error) {
    try {
      await writeFile(targetFull, target.next ?? "", "utf8");
    } catch (rollbackError) {
      return NextResponse.json({
        success: false,
        error: `Undo history failed: ${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      }, { status: 500 });
    }
    return NextResponse.json({ success: false, error: "Undo history failed; the file was restored to its pre-undo contents." }, { status: 500 });
  }
  return NextResponse.json({ success: true, action: "restored", path: target.path, content: target.prev });
}

async function undoPending(root: string, body: Record<string, unknown>) {
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ success: false, error: "request too large" }, { status: 413 });
  }
  const all = getPendingHistoryChanges(await readHistory(root));
  const selected = Array.isArray(body.paths)
    ? body.paths.filter((path): path is string => typeof path === "string")
    : [];
  if (!selected.length || (Array.isArray(body.paths) && selected.length !== body.paths.length)) {
    return NextResponse.json({ success: false, error: "paths required" }, { status: 400 });
  }
  const wanted = new Set(selected);
  const changes = all.filter((change) => wanted.has(change.path));
  if (changes.length !== wanted.size) {
    return NextResponse.json({ success: false, error: "one or more files are no longer pending" }, { status: 409 });
  }

  const targets = [];
  const changedPaths: string[] = [];
  for (const change of changes) {
    const safe = await assertSafeWrite(root, change.path);
    const full = safeJoinWorkspace(root, change.path);
    if (!safe.ok || !full) {
      return NextResponse.json({ success: false, error: safe.ok ? "path escapes workspace" : safe.reason }, { status: 403 });
    }
    let current: Buffer | null = null;
    try {
      current = await readFile(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return NextResponse.json({ success: false, error: `Could not read ${change.path}: ${error instanceof Error ? error.message : String(error)}` }, { status: 500 });
      }
    }
    const currentValue = current === null
      ? null
      : change.encoding === "base64" ? current.toString("base64") : current.toString("utf8");
    const changed = currentValue !== change.next;
    if (changed) changedPaths.push(change.path);
    targets.push({ ...change, full, current, changed });
  }
  if (changedPaths.length && body.confirmChanges !== true) {
    return NextResponse.json({
      success: false,
      error: "Some files changed on disk after the agent's last write.",
      changedPaths,
    }, { status: 409 });
  }

  const applied: typeof targets = [];
  const rollbackTargets = async () => {
    const rollbackErrors: string[] = [];
    for (const target of [...applied].reverse()) {
      try {
        if (target.current === null) await rm(target.full, { force: true });
        else {
          await mkdir(dirname(target.full), { recursive: true });
          await writeFile(target.full, target.current);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${target.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    return rollbackErrors;
  };
  try {
    for (const target of targets) {
      const safe = await assertSafeWrite(root, target.path);
      if (!safe.ok) throw new Error(safe.reason);
      let actual: Buffer | null = null;
      try {
        actual = await readFile(target.full);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if ((actual === null) !== (target.current === null) ||
          (actual !== null && target.current !== null && !actual.equals(target.current))) {
        throw new Error(`${target.path} changed during undo; no remaining files were modified`);
      }
      applied.push(target);
      if (target.prev === null) {
        await rm(target.full, { force: true });
      } else {
        await mkdir(dirname(target.full), { recursive: true });
        const data = target.encoding === "base64"
          ? Buffer.from(target.prev, "base64")
          : Buffer.from(target.prev, "utf8");
        await writeFile(target.full, data);
      }
    }
  } catch (error) {
    const rollbackErrors = await rollbackTargets();
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({
      success: false,
      error: `Undo failed: ${message}${rollbackErrors.length ? `; rollback also failed for ${rollbackErrors.join(", ")}` : "; all applied files were restored to their pre-undo state"}`,
    }, { status: 500 });
  }

  try {
    const kept = await appendKeepMarkers(root, selected, "browser");
    if (!kept) throw new Error("could not append Keep markers");
  } catch (error) {
    const rollbackErrors = await rollbackTargets();
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({
      success: false,
      error: `Undo history could not be committed: ${message}${rollbackErrors.length ? `; rollback failed for ${rollbackErrors.join(", ")}` : "; all files were restored to their pre-undo state and snapshots remain pending"}`,
    }, { status: 500 });
  }
  return NextResponse.json({ success: true, undone: selected });
}
