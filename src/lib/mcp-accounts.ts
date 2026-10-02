// mcp-accounts.ts — Per-user MCP server connections ("Connectors").
//
// The catalog (mcp-catalog.ts) lists what CAN be connected; this module owns
// what a user HAS connected. Rows live in McpServerConfig with the Claude
// Code wire shape (command/args/env); secret env values are AES-256-GCM
// encrypted with the same key as BYOK provider keys (key-encryption.ts).
//
// The executor calls collectMcpServerConfigs() per run: the user's connected
// servers are merged with any orplex.config.json mcpServers declared in the
// workspace, capped by the same MAX_SERVERS budget as mcp-client.ts.

import { prisma } from "@/lib/prisma";
import { decryptKey, encryptKey, maskKey } from "@/lib/key-encryption";
import { getMcpCatalogEntry, type McpCatalogEntry, type McpEnvSpec } from "@/lib/mcp-catalog";
import type { McpServerConfig } from "@/lib/mcp-client";

export const MAX_MCP_SERVERS_PER_RUN = 2; // mirrors mcp-client MAX_SERVERS
const MAX_SERVERS_PER_USER = 20;

/** Which env keys of a catalog entry are secrets (never returned raw). */
function secretKeys(entry: McpCatalogEntry): Set<string> {
  return new Set(entry.envSpec.filter((s) => s.secret).map((s) => s.key));
}

export interface ConnectedServer {
  id: string; // row id
  serverId: string; // catalog id
  label: string;
  name: string; // catalog name
  description: string;
  category: string;
  enabled: boolean;
  command: string;
  args: string[];
  env: Record<string, string>; // secrets masked
  secretsSet: string[]; // env keys holding a stored secret
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  docsUrl: string | null;
}

function toConnected(row: {
  id: string;
  serverId: string;
  label: string | null;
  command: string;
  args: unknown;
  env: unknown;
  enabled: boolean;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
}): ConnectedServer | null {
  const entry = getMcpCatalogEntry(row.serverId);
  const args = Array.isArray(row.args) ? (row.args as string[]) : [];
  const envRaw = row.env && typeof row.env === "object" ? (row.env as Record<string, unknown>) : {};
  const secrets = entry ? secretKeys(entry) : new Set<string>();
  const env: Record<string, string> = {};
  const secretsSet: string[] = [];
  for (const [k, v] of Object.entries(envRaw)) {
    if (typeof v !== "string" || v === "") continue;
    if (secrets.has(k)) {
      // Stored value is ciphertext; show only a mask over the PLAINTEXT shape.
      try {
        env[k] = maskKey(decryptKey(v));
      } catch {
        env[k] = "••••";
      }
      secretsSet.push(k);
    } else {
      env[k] = v;
    }
  }
  return {
    id: row.id,
    serverId: row.serverId,
    label: row.label ?? entry?.name ?? row.serverId,
    name: entry?.name ?? row.serverId,
    description: entry?.description ?? "",
    category: entry?.category ?? "",
    enabled: row.enabled,
    command: row.command,
    args,
    env,
    secretsSet,
    lastTestAt: row.lastTestAt ? row.lastTestAt.toISOString() : null,
    lastTestOk: row.lastTestOk,
    docsUrl: entry?.docsUrl ?? null,
  };
}

/** All of a user's connected servers (masked). Empty array when none. */
export async function listConnectedServers(userId: string): Promise<ConnectedServer[]> {
  const rows = await prisma.mcpServerConfig.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toConnected).filter((s): s is ConnectedServer => s !== null);
}

export interface ConnectResult {
  ok: boolean;
  status: number;
  server?: ConnectedServer;
  error?: string;
}

/**
 * Connect (or re-save) a catalog server for a user. Env values that map to
 * secret envSpec keys are encrypted at rest; plain values pass through.
 * An existing row is updated in place — secrets the user leaves blank are
 * preserved so the UI can post only the fields that changed.
 */
export async function connectServer(
  userId: string,
  serverId: string,
  input: { label?: string; env?: Record<string, unknown>; args?: unknown[]; enabled?: boolean }
): Promise<ConnectResult> {
  const entry = getMcpCatalogEntry(serverId);
  if (!entry) return { ok: false, status: 404, error: `unknown MCP server "${serverId.slice(0, 60)}"` };

  const count = await prisma.mcpServerConfig.count({ where: { userId } });
  const existing = await prisma.mcpServerConfig.findUnique({ where: { userId_serverId: { userId, serverId } } });
  if (!existing && count >= MAX_SERVERS_PER_USER) {
    return { ok: false, status: 400, error: `connector limit reached (${MAX_SERVERS_PER_USER}) — remove one first` };
  }

  const secrets = secretKeys(entry);
  const prevEnv = existing && existing.env && typeof existing.env === "object" ? (existing.env as Record<string, string>) : {};
  const envOut: Record<string, string> = {};
  const supplied = input.env ?? {};
  for (const spec of entry.envSpec as McpEnvSpec[]) {
    const raw = supplied[spec.key];
    if (typeof raw === "string" && raw.trim() !== "") {
      envOut[spec.key] = secrets.has(spec.key) ? encryptKey(raw.trim()) : raw.trim();
    } else if (prevEnv[spec.key]) {
      envOut[spec.key] = prevEnv[spec.key]; // blank → keep stored value
    }
  }

  const args = Array.isArray(input.args) && input.args.every((a) => typeof a === "string")
    ? (input.args as string[])
    : existing
      ? (Array.isArray(existing.args) ? (existing.args as string[]) : entry.args)
      : entry.args;

  const row = await prisma.mcpServerConfig.upsert({
    where: { userId_serverId: { userId, serverId } },
    create: {
      userId,
      serverId,
      label: input.label?.slice(0, 80) || entry.name,
      command: entry.command,
      args,
      env: envOut,
      enabled: input.enabled ?? true,
    },
    update: {
      ...(input.label !== undefined ? { label: input.label.slice(0, 80) || entry.name } : {}),
      args,
      env: envOut,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    },
  });
  const server = toConnected({ ...row, args: row.args, env: row.env });
  return server ? { ok: true, status: 200, server } : { ok: false, status: 500, error: "save failed" };
}

export async function disconnectServer(userId: string, serverId: string): Promise<boolean> {
  const res = await prisma.mcpServerConfig.deleteMany({ where: { userId, serverId } });
  return res.count > 0;
}

export async function setServerEnabled(userId: string, serverId: string, enabled: boolean): Promise<boolean> {
  const res = await prisma.mcpServerConfig.updateMany({ where: { userId, serverId }, data: { enabled } });
  return res.count > 0;
}

export async function recordTestResult(userId: string, serverId: string, ok: boolean): Promise<void> {
  await prisma.mcpServerConfig.updateMany({
    where: { userId, serverId },
    data: { lastTestAt: new Date(), lastTestOk: ok },
  });
}

// ── Executor side ───────────────────────────────────────────────────────────

/**
 * Decrypted spawn config for ONE server (no cap) — used by test-connection.
 * Null when the user has not connected (or has disabled) the server.
 */
export async function getServerRunConfig(userId: string, serverId: string): Promise<McpServerConfig | null> {
  const row = await prisma.mcpServerConfig.findUnique({ where: { userId_serverId: { userId, serverId } } });
  if (!row || !row.enabled) return null;
  const entry = getMcpCatalogEntry(row.serverId);
  const envRaw = row.env && typeof row.env === "object" ? (row.env as Record<string, unknown>) : {};
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(envRaw)) {
    if (typeof v !== "string" || v === "") continue;
    if (entry?.envSpec.find((s) => s.key === k)?.secret) {
      try {
        env[k] = decryptKey(v);
      } catch {
        env[k] = "";
      }
    } else {
      env[k] = v;
    }
  }
  const args = Array.isArray(row.args) ? (row.args as string[]) : [];
  return {
    command: row.command,
    args: args.length > 0 ? args : (entry?.args ?? []),
    env: Object.keys(env).length > 0 ? env : undefined,
  };
}

/**
 * Enabled connectors for a user, decrypted into spawn-ready config, capped
 * at MAX_MCP_SERVERS_PER_RUN (stable order: most recently tested OK first,
 * then creation order — so the two that actually run are predictable).
 */
export async function collectMcpServerConfigs(userId: string): Promise<Record<string, McpServerConfig>> {
  const rows = await prisma.mcpServerConfig.findMany({ where: { userId, enabled: true } });
  const out: Record<string, McpServerConfig> = {};
  const ranked = rows
    .map((r) => ({
      r,
      rank: r.lastTestOk === true ? 0 : r.lastTestOk === false ? 2 : 1,
    }))
    .sort((a, b) => a.rank - b.rank);
  for (const { r } of ranked.slice(0, MAX_MCP_SERVERS_PER_RUN)) {
    const entry = getMcpCatalogEntry(r.serverId);
    const envRaw = r.env && typeof r.env === "object" ? (r.env as Record<string, unknown>) : {};
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(envRaw)) {
      if (typeof v !== "string" || v === "") continue;
      if (entry?.envSpec.find((s) => s.key === k)?.secret) {
        try {
          env[k] = decryptKey(v);
        } catch {
          env[k] = ""; // undecryptable secret → empty, server will fail honestly
        }
      } else {
        env[k] = v;
      }
    }
    const args = Array.isArray(r.args) ? (r.args as string[]) : [];
    out[r.serverId] = {
      command: r.command,
      args: args.length > 0 ? args : (entry?.args ?? []),
      env: Object.keys(env).length > 0 ? env : undefined,
    };
  }
  return out;
}
