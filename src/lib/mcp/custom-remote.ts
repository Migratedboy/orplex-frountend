// custom-remote.ts — user-added remote MCP servers (OAuth) that are NOT in
// the catalog (the Connectors panel's "Remote servers (OAuth)" → "Connect
// with browser"). Before this existed, startAuthorization required a catalog
// id, so custom remotes could only ever ride the Electron main-process flow
// (tokens in renderer localStorage) and their tools NEVER reached the
// agent's SDK-lane roster — "Connect with browser" was a dead end by design.
//
// Design: catalog ids are vendor slugs; custom remotes get `remote-<hash>`
// ids derived from the endpoint URL, so the two namespaces can never collide
// (no catalog id starts with "remote-", enforced at upsert + collision-free
// by construction). Storage is the SAME McpConnection table the OAuth path
// already uses: the row is created here with status "disconnected" and NO
// tokens — the standard start/complete flow (flow.ts) then runs against the
// resolved entry and stores credentials exactly like a catalog connector,
// and the hub resolves these rows so their tools reach the roster.

import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { getMcpCatalogEntry, type McpCatalogEntry } from "@/lib/mcp-catalog";
import { checkMcpUrl } from "./ssrf-fetch";

export const REMOTE_ID_PREFIX = "remote-";

export function isCustomRemoteId(serverId: string): boolean {
  return serverId.startsWith(REMOTE_ID_PREFIX);
}

/** Stable, collision-free id derived from the endpoint URL. */
export function customRemoteIdFor(url: string): string {
  return REMOTE_ID_PREFIX + createHash("sha1").update(url).digest("hex").slice(0, 12);
}

export interface CustomRemoteInput {
  url: string;
  /** Preferred streamable-http; sse offered for legacy endpoints. */
  transport?: string;
}

/**
 * Register (or refresh) a custom remote endpoint for this user. The URL goes
 * through the same SSRF policy as every other MCP endpoint (https or plain
 * loopback only) — never trust a user-entered URL without it.
 */
export async function upsertCustomRemote(
  userId: string,
  input: CustomRemoteInput
): Promise<{ serverId: string; entry: McpCatalogEntry }> {
  const url = input.url.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("enter a valid URL (https://…)");
  }
  // checkMcpUrl is the shared policy: https (or plain http loopback), no
  // private-IP tunneling tricks. Mirrors what the catalog audit enforces.
  const verdict = checkMcpUrl(url);
  if (!verdict.allowed) throw new Error(`URL blocked by SSRF policy: ${verdict.reason}`);

  const transport = input.transport === "sse" ? "sse" : "streamable-http";
  const serverId = customRemoteIdFor(url);
  if (getMcpCatalogEntry(serverId)) {
    // Defensive: a catalog id can never have this prefix, but a catalog
    // endpoint itself must be connected through its own row, not here.
    throw new Error("this endpoint is a catalog connector — connect it from its catalog entry");
  }
  await prisma.mcpConnection.upsert({
    where: { userId_serverId: { userId, serverId } },
    create: { userId, serverId, url, transport, status: "disconnected" },
    update: { url, transport },
  });
  return { serverId, entry: makeCustomRemoteEntry(serverId, url, transport) };
}

/** Resolve a custom remote's synthetic catalog entry (null if none exists). */
export async function loadCustomRemote(userId: string, serverId: string): Promise<McpCatalogEntry | null> {
  if (!isCustomRemoteId(serverId)) return null;
  // A catalog id never collides with the prefix; the reverse check keeps a
  // future slug rename from silently shadowing a catalog entry.
  if (getMcpCatalogEntry(serverId)) return null;
  const row = await prisma.mcpConnection.findUnique({
    where: { userId_serverId: { userId, serverId } },
  });
  if (!row) return null;
  return makeCustomRemoteEntry(row.serverId, row.url, row.transport);
}

/** Remove a custom remote entirely (row + its tool snapshot). */
export async function deleteCustomRemote(userId: string, serverId: string): Promise<boolean> {
  if (!isCustomRemoteId(serverId)) return false;
  if (getMcpCatalogEntry(serverId)) return false;
  const existing = await prisma.mcpConnection.findUnique({
    where: { userId_serverId: { userId, serverId } },
    select: { id: true },
  });
  if (!existing) return false;
  await prisma.mcpConnection.delete({ where: { id: existing.id } });
  // The Phase 5 roster has no reason to advertise tools of a deleted server.
  await prisma.mcpTool.deleteMany({ where: { userId, serverId } });
  return true;
}

/**
 * The synthetic catalog entry every flow/hub call site sees. auth is always
 * "oauth": the standard start/complete flow handles the browser leg, and the
 * runtime provider attaches stored tokens (needs_reauth on expiry, exactly
 * like catalog connectors).
 */
export function makeCustomRemoteEntry(serverId: string, url: string, transport: string): McpCatalogEntry {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // keep the raw url as the display name
  }
  return {
    id: serverId,
    name: host,
    description: `User-added remote MCP server — ${url}`,
    category: "cloud",
    auth: "oauth",
    remote: { url, transport: transport === "sse" ? "sse" : "streamable-http" },
  };
}
