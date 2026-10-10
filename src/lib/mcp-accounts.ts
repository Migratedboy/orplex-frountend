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
import { getMcpCatalogEntry, type McpCatalogEntry } from "@/lib/mcp-catalog";
import { checkMcpUrl } from "@/lib/mcp/ssrf-fetch";
import { withConnectionLock } from "@/lib/mcp/oauth/store";
import { getWorkspaceCwdForUser } from "@/lib/workspace-cwd";
import type { McpServerConfig } from "@/lib/mcp-client";

export const MAX_MCP_SERVERS_PER_RUN = 2; // mirrors mcp-client MAX_SERVERS
const MAX_SERVERS_PER_USER = 20;

// ── Connector input validation ────────────────────────────────────────
// Stored argv reaches `cmd /s /c` on Windows (mcp-client.ts) with minimal
// quoting, so validation here is the primary gate; the spawn layer
// re-checks (defense in depth for rows saved before this gate existed).
const MAX_CONNECTOR_ARGS = 32;
const MAX_ARG_CHARS = 2048;
const MAX_ENV_VALUE_CHARS = 8192;
// Shell metacharacters (cmd + POSIX): quotes, separators, substitution,
// redirection, expansion, control chars. Legit argv elements (paths, flags,
// key=value, URLs) never need these.
const ARG_UNSAFE = /[";&|$`()\n\r<>^%!]/;

/** True for `scheme://…` values (URLs), as opposed to paths/flags. */
function looksLikeUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

/**
 * Validate one user-supplied argv element. `catalogUrls` are the entry's own
 * URL args (trusted verbatim); any OTHER URL must pass the SSRF policy.
 * Returns an error string, or null when clean. Exported for the spawn-time
 * re-check in mcp-client.ts.
 */
export function connectorArgError(arg: string, catalogUrls: Set<string>): string | null {
  if (arg.length > MAX_ARG_CHARS) return `argument too long (max ${MAX_ARG_CHARS} chars)`;
  if (ARG_UNSAFE.test(arg)) return `argument contains shell metacharacters: ${arg.slice(0, 60)}`;
  if (looksLikeUrl(arg)) {
    if (/^https?:\/\//i.test(arg)) {
      if (!catalogUrls.has(arg)) {
        const verdict = checkMcpUrl(arg);
        if (!verdict.allowed) return `URL blocked by SSRF policy: ${verdict.reason}`;
      }
    } else {
      return `only http(s) URLs allowed in arguments: ${arg.slice(0, 80)}`;
    }
  }
  return null;
}

/** Which env vars of a catalog entry are secrets (never returned raw). */
function secretKeys(entry: McpCatalogEntry): Set<string> {
  return new Set((entry.stdio?.env ?? []).filter((v) => v.secret).map((v) => v.name));
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
 * secret vars declared by the catalog entry are encrypted at rest; plain
 * values pass through. An existing row is updated in place — secrets the user
 * leaves blank are preserved so the UI can post only the fields that changed.
 */
export async function connectServer(
  userId: string,
  serverId: string,
  input: { label?: string; env?: Record<string, unknown>; args?: unknown[]; enabled?: boolean }
): Promise<ConnectResult> {
  const entry = getMcpCatalogEntry(serverId);
  if (!entry) return { ok: false, status: 404, error: `unknown MCP server "${serverId.slice(0, 60)}"` };
  if (!entry.stdio) {
    return { ok: false, status: 400, error: `${entry.name} connects over OAuth — no token/stdio path to save` };
  }
  const stdio = entry.stdio;
  // Serialize read-modify-write per connector: two concurrent saves would
  // otherwise interleave prevEnv reads and drop each other's secrets.
  return withConnectionLock(`mcp-stdio:${userId}:${serverId}`, () =>
    connectServerInner(userId, serverId, input, entry, stdio)
  );
}

async function connectServerInner(
  userId: string,
  serverId: string,
  input: { label?: string; env?: Record<string, unknown>; args?: unknown[]; enabled?: boolean },
  entry: McpCatalogEntry,
  stdio: NonNullable<McpCatalogEntry["stdio"]>
): Promise<ConnectResult> {
  const count = await prisma.mcpServerConfig.count({ where: { userId } });
  const existing = await prisma.mcpServerConfig.findUnique({ where: { userId_serverId: { userId, serverId } } });
  if (!existing && count >= MAX_SERVERS_PER_USER) {
    return { ok: false, status: 400, error: `connector limit reached (${MAX_SERVERS_PER_USER}) — remove one first` };
  }

  const secrets = secretKeys(entry);
  const prevEnv = existing && existing.env && typeof existing.env === "object" ? (existing.env as Record<string, string>) : {};
  const envOut: Record<string, string> = {};
  const supplied = input.env ?? {};
  for (const [k, v] of Object.entries(supplied)) {
    if (typeof v === "string" && v.length > MAX_ENV_VALUE_CHARS) {
      return { ok: false, status: 400, error: `value for ${k} too long (max ${MAX_ENV_VALUE_CHARS} chars)` };
    }
  }
  for (const spec of stdio.env) {
    const raw = supplied[spec.name];
    if (typeof raw === "string" && raw.trim() !== "") {
      envOut[spec.name] = secrets.has(spec.name) ? encryptKey(raw.trim()) : raw.trim();
    } else if (prevEnv[spec.name]) {
      envOut[spec.name] = prevEnv[spec.name]; // blank → keep stored value
    }
  }
  // Required env must be present after merge — a row that can never launch
  // must fail here with names, not at probe time with a cryptic spawn error.
  const missing = stdio.env.filter((s) => s.required && !envOut[s.name]).map((s) => s.name);
  if (missing.length > 0) {
    return { ok: false, status: 400, error: `missing required values: ${missing.join(", ")}` };
  }

  const catalogUrls = new Set((stdio.args ?? []).filter(looksLikeUrl));
  let resolvedArgs: string[];
  if (input.args !== undefined) {
    if (!Array.isArray(input.args) || !input.args.every((a) => typeof a === "string")) {
      return { ok: false, status: 400, error: "args must be an array of strings" };
    }
    if (input.args.length > MAX_CONNECTOR_ARGS) {
      return { ok: false, status: 400, error: `too many arguments (max ${MAX_CONNECTOR_ARGS})` };
    }
    for (const a of input.args as string[]) {
      const problem = connectorArgError(a, catalogUrls);
      if (problem) return { ok: false, status: 400, error: problem };
    }
    resolvedArgs = input.args as string[];
  } else if (existing && Array.isArray(existing.args)) {
    // Re-validate previously stored rows too (saved before this gate
    // existed): a dangerous stored row must not survive a re-save untouched.
    resolvedArgs = existing.args as string[];
    for (const a of resolvedArgs) {
      if (typeof a !== "string") return { ok: false, status: 400, error: "stored arguments are corrupt — supply fresh args" };
      const problem = connectorArgError(a, catalogUrls);
      if (problem) return { ok: false, status: 400, error: `stored ${problem} — supply corrected args` };
    }
  } else {
    resolvedArgs = stdio.args;
    // Catalog defaults can carry `<placeholder>` template text (supabase's
    // `--project-ref=<project-ref>`). Saving that verbatim would store an
    // argument the spawn layer must refuse — fail here instead, naming the
    // exact placeholder to replace.
    const template = resolvedArgs.find((a) => /<[^>]{1,60}>/.test(a));
    if (template) {
      const token = template.match(/<[^>]{1,60}>/)?.[0] ?? "<...>";
      return { ok: false, status: 400, error: `connector needs your real value for ${token} — supply args with the placeholder replaced` };
    }
  }
  // A bare "." means "the server's cwd" — always the wrong directory.
  // Substitute the user's registered workspace; refuse when none is open.
  if (resolvedArgs.includes(".")) {
    const cwd = getWorkspaceCwdForUser(userId);
    if (!cwd) {
      return { ok: false, status: 400, error: "this connector needs a workspace folder path — open a folder first, or supply an absolute path" };
    }
    resolvedArgs = resolvedArgs.map((a) => (a === "." ? cwd : a));
  }
  const args = resolvedArgs;

  const row = await prisma.mcpServerConfig.upsert({
    where: { userId_serverId: { userId, serverId } },
    create: {
      userId,
      serverId,
      label: input.label?.slice(0, 80) || entry.name,
      command: stdio.command,
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
    if ((entry?.stdio?.env ?? []).find((s) => s.name === k)?.secret) {
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
    args: args.length > 0 ? args : (entry?.stdio?.args ?? []),
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
      if ((entry?.stdio?.env ?? []).find((s) => s.name === k)?.secret) {
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
      args: args.length > 0 ? args : (entry?.stdio?.args ?? []),
      env: Object.keys(env).length > 0 ? env : undefined,
    };
  }
  return out;
}
