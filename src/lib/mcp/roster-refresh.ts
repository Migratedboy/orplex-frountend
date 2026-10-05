// roster-refresh.ts — self-healing Phase 5 discovery for the SDK lane.
//
// Nothing before Phase 9 ever called hubListTools, so the McpTool snapshot
// (the ONLY roster the chat prompt, executor, connection tool counts, and
// /api/agent/mcp/tools read) never got written in production. Two triggers
// close that:
//   • after OAuth sign-in — POST /api/mcp/oauth/complete fires
//     refreshServerSnapshot (fire-and-forget);
//   • on roster fetch — refreshMissingSnapshots awaits discovery for every
//     connected server that has no snapshot rows yet, so a pre-Phase-9
//     connection (or a lost snapshot) heals on the next session instead of
//     showing "missing tools" forever.
// Failures are swallowed: an unreachable server must never fail the route.

import { listConnections } from "./oauth/store";
import { hubListTools } from "./hub";
import { listSnapshotToolsByServer, syncToolSnapshot } from "./tool-snapshot";

/**
 * Discover one server's tools through the hub and persist them as the
 * snapshot. hubListTools fires its own fire-and-forget sync; the explicit
 * await here makes the write deterministic for the caller (the roster route
 * re-reads right after). Idempotent — syncToolSnapshot upserts by
 * (userId, serverId, name), and a concurrent duplicate can only lose a
 * no-op diff (callers .catch anyway).
 */
export async function refreshServerSnapshot(userId: string, serverId: string): Promise<void> {
  const tools = await hubListTools(userId, serverId);
  await syncToolSnapshot(userId, serverId, tools);
}

/**
 * For every connected mcpConnection row whose server is missing from the
 * current snapshot, run discovery — in parallel (one shared timeout budget,
 * not N x HUB_LIST_TIMEOUT_MS), errors swallowed per server.
 */
export async function refreshMissingSnapshots(userId: string): Promise<void> {
  const have = new Set(
    (await listSnapshotToolsByServer(userId).catch(() => [])).map((t) => t.server)
  );
  const rows = await listConnections(userId).catch(() => []);
  const targets = rows.filter(
    (c) =>
      (c.status === "connected" || c.status === "connected_no_tools") &&
      !have.has(c.serverId)
  );
  await Promise.allSettled(targets.map((c) => refreshServerSnapshot(userId, c.serverId)));
}
