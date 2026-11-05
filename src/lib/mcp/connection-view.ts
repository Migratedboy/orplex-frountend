// connection-view.ts — the Connectors-panel read model (spec Phase 7).
// Joins SafeConnection rows (store.ts — never tokens) with catalog metadata
// and the Phase 5 tool snapshot so the panel can show one line per connector:
// display name, auth mode, status, tool count, auto-approve toggle.

import { prisma } from "@/lib/prisma";
import { getMcpCatalogEntry, type McpAuthType } from "@/lib/mcp-catalog";
import { isCustomRemoteId } from "./custom-remote";
import { listConnections, type SafeConnection } from "./oauth/store";

export interface ConnectionView extends SafeConnection {
  name: string;
  description: string;
  auth: McpAuthType;
  /** Phase 5 snapshot size — 0 with status "connected" means tools/list was empty. */
  toolCount: number;
}

export async function listConnectionViews(userId: string): Promise<ConnectionView[]> {
  const [rows, counts] = await Promise.all([
    listConnections(userId),
    prisma.mcpTool.groupBy({
      by: ["serverId"],
      where: { userId },
      _count: { _all: true },
    }),
  ]);
  const toolCounts = new Map(counts.map((c) => [c.serverId, c._count._all]));
  return rows.map((r) => {
    const entry = getMcpCatalogEntry(r.serverId);
    // Custom remotes (remote-<hash> ids) have no catalog row to read — show
    // the endpoint host as the name; the row's url/transport carry the rest.
    const customRemote = !entry && isCustomRemoteId(r.serverId);
    const name = entry?.name ?? (customRemote ? hostOf(r.url) : r.serverId);
    const auth: McpAuthType = customRemote ? "oauth" : (entry?.auth ?? "none");
    return {
      ...r,
      name,
      description: entry?.description ?? r.url,
      auth,
      toolCount: toolCounts.get(r.serverId) ?? 0,
    };
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
