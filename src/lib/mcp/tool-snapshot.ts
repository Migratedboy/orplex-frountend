// tool-snapshot.ts — persistent McpTool discovery records (Phase 5).
//
// The hub writes a snapshot after every successful tools/list; the AI loops
// read it back through tool-builder (C5). The McpConnection status flips to
// `connected` / `connected_no_tools` on each sync — and NEVER clobbers
// needs_reauth/disconnected, which are the OAuth/connect state machines'
// to write.
//
// Server-only: imports Prisma. Keep tool-builder pure.

import { prisma } from "@/lib/prisma";
import type { PrismaPromise } from "@prisma/client";
import type { BuilderTool } from "./tool-builder";

/** Hard cap on rows per server — a hostile/broken server can't flood the table. */
export const SNAPSHOT_MAX_TOOLS = 500;

export interface SnapshotTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: unknown;
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
  /** Connection status implied by the result — caller applies it if allowed. */
  status: "connected" | "connected_no_tools";
}

function fingerprint(t: { description: string; inputSchema: unknown; annotations?: unknown }): string {
  try {
    return JSON.stringify([t.description, t.inputSchema, t.annotations ?? null]);
  } catch {
    return `${t.description}|unserializable`;
  }
}

/** Pure prev×next diff — added / removed / same-name-changed / unchanged. */
export function diffTools(prev: SnapshotTool[], next: SnapshotTool[]): SnapshotDiff {
  const prevByName = new Map(prev.map((t) => [t.name, t]));
  const nextNames = new Set(next.map((t) => t.name));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;
  for (const t of next) {
    const before = prevByName.get(t.name);
    if (!before) added.push(t.name);
    else if (fingerprint(before) !== fingerprint(t)) changed.push(t.name);
    else unchanged++;
  }
  for (const t of prev) {
    if (!nextNames.has(t.name)) removed.push(t.name);
  }
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
    unchanged,
    status: next.length > 0 ? "connected" : "connected_no_tools",
  };
}

interface Row {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations: unknown;
}

function toSnapshot(rows: Row[]): SnapshotTool[] {
  return rows.map((r) => ({
    name: r.name,
    description: r.description ?? "",
    inputSchema: r.inputSchema ?? { type: "object", properties: {} },
    ...(r.annotations ? { annotations: r.annotations } : {}),
  }));
}

/** One server's snapshot, ordered by tool name. */
export async function getToolSnapshot(userId: string, serverId: string): Promise<SnapshotTool[]> {
  const rows = await prisma.mcpTool.findMany({
    where: { userId, serverId },
    orderBy: { name: "asc" },
  });
  return toSnapshot(rows);
}

/** Every snapshot row for a user, flattened for tool-builder (chat route lane). */
export async function listSnapshotToolsByServer(userId: string): Promise<BuilderTool[]> {
  const rows = await prisma.mcpTool.findMany({
    where: { userId },
    orderBy: [{ serverId: "asc" }, { name: "asc" }],
  });
  return rows.map((r) => ({
    server: r.serverId,
    name: r.name,
    description: r.description ?? "",
    inputSchema: r.inputSchema ?? { type: "object", properties: {} },
    ...(r.annotations ? { annotations: r.annotations as BuilderTool["annotations"] } : {}),
  }));
}

/**
 * Persist a fresh tools/list and return the diff. Writes are capped at
 * SNAPSHOT_MAX_TOOLS; connection status flips only from a connected-ish
 * starting point (see file header).
 */
export async function syncToolSnapshot(
  userId: string,
  serverId: string,
  tools: Array<{ name: string; description?: string; inputSchema?: unknown; annotations?: unknown }>
): Promise<SnapshotDiff> {
  const capped = tools.slice(0, SNAPSHOT_MAX_TOOLS);
  const next: SnapshotTool[] = capped.map((t) => ({
    name: t.name,
    description: typeof t.description === "string" ? t.description : "",
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    ...(t.annotations ? { annotations: t.annotations } : {}),
  }));

  const prev = await getToolSnapshot(userId, serverId);
  const diff = diffTools(prev, next);

  const connection = await prisma.mcpConnection.findUnique({
    where: { userId_serverId: { userId, serverId } },
    select: { status: true },
  });
  const statusFlipAllowed =
    connection?.status === "connected" || connection?.status === "connected_no_tools";

  const names = next.map((t) => t.name);
  const keep = prev.map((t) => t.name).filter((n) => !names.includes(n));
  const deletes = keep.length
    ? [
        prisma.mcpTool.deleteMany({
          where: { userId, serverId, name: { in: keep } },
        }),
      ]
    : [];

  const upserts = next.map((t) =>
    prisma.mcpTool.upsert({
      where: { userId_serverId_name: { userId, serverId, name: t.name } },
      update: {
        description: t.description,
        inputSchema: t.inputSchema as object,
        annotations: (t.annotations as object | undefined) ?? undefined,
        lastSeenAt: new Date(),
      },
      create: {
        userId,
        serverId,
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as object,
        annotations: (t.annotations as object | undefined) ?? undefined,
      },
    })
  );

  const ops: Array<PrismaPromise<unknown>> = [...deletes, ...upserts];
  if (statusFlipAllowed && connection && connection.status !== diff.status) {
    ops.push(
      prisma.mcpConnection.update({
        where: { userId_serverId: { userId, serverId } },
        data: { status: diff.status },
      })
    );
  }

  if (ops.length) await prisma.$transaction(ops);
  return diff;
}

/** Drop a server's snapshot (disconnect / server removal). Returns row count. */
export async function clearToolSnapshot(userId: string, serverId: string): Promise<number> {
  const res = await prisma.mcpTool.deleteMany({ where: { userId, serverId } });
  return res.count;
}

/**
 * Prisma-backed per-server prefs for the SDK lane (C6): the same
 * auto-approve-read-only toggle the browser lane keeps in localStorage —
 * one setting, two lookups per transport lane.
 */
export async function loadMcpServerPrefsDb(
  userId: string,
  serverId: string
): Promise<{ autoApproveReadOnly: boolean }> {
  const row = await prisma.mcpConnection.findUnique({
    where: { userId_serverId: { userId, serverId } },
    select: { autoApproveReadOnly: true },
  });
  return { autoApproveReadOnly: row?.autoApproveReadOnly ?? false };
}
