// store.ts — persistence for OAuth connections to remote MCP servers
// (spec Phase 2). Two safety properties, both enforced here:
//
// 1. Tokens exist ONLY as AES-256-GCM ciphertext in mcp_connections
//    (same key as BYOK, key-encryption.ts). Readers decrypt in-process;
//    nothing raw is ever returned to the renderer, logs, or prompts.
// 2. Writes are serialized per (userId, serverId) by an in-process mutex and
//    guarded by the row's `version` (optimistic lock), so a background token
//    refresh and a foreground save cannot clobber each other. Version
//    conflicts retry against the fresh row, then fail typed.

import type { StoredOAuthClientInformation, StoredOAuthTokens } from "@modelcontextprotocol/client";
import { decryptKey, encryptKey } from "@/lib/key-encryption";
import { prisma } from "@/lib/prisma";

export type McpConnectionStatus = "connected" | "connected_no_tools" | "needs_reauth" | "disconnected";
export type McpTransport = "streamable-http" | "sse";

/** Thrown when the version guard exhausts its retries (row churned or deleted). */
export class McpTokenConflictError extends Error {
  readonly code = "mcp_token_conflict";
  constructor(
    readonly userId: string,
    readonly serverId: string
  ) {
    super(`MCP connection "${serverId}" changed concurrently during token write (version exhausted)`);
    this.name = "McpTokenConflictError";
  }
}

// ── Per-connection mutex ────────────────────────────────────────────────────

const locks = new Map<string, Promise<unknown>>();

/**
 * Serializes async work per key within this process. A waiter whose
 * predecessor rejected still runs (the tail never rejects).
 */
export function withConnectionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  locks.set(key, tail);
  return run.finally(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
}

function lockKey(userId: string, serverId: string): string {
  return `${userId}:${serverId}`;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

// ── Row helpers ─────────────────────────────────────────────────────────────

type ConnectionRow = NonNullable<Awaited<ReturnType<typeof findConnection>>>;

async function findConnection(userId: string, serverId: string) {
  return prisma.mcpConnection.findUnique({ where: { userId_serverId: { userId, serverId } } });
}

/** Create the connection row if missing (status "disconnected" until tokens land). */
async function ensureConnectionRow(
  userId: string,
  serverId: string,
  base: { url: string; transport: McpTransport }
): Promise<ConnectionRow> {
  const existing = await findConnection(userId, serverId);
  if (existing) return existing;
  try {
    return await prisma.mcpConnection.create({
      data: { userId, serverId, url: base.url, transport: base.transport, status: "disconnected" },
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const row = await findConnection(userId, serverId);
    if (row) return row;
    throw e;
  }
}

const VERSION_RETRIES = 3;

/**
 * Version-guarded update: `WHERE id AND version`, then bump. On a miss,
 * re-read the fresh version and retry (bounded), else throw typed.
 */
async function versionedUpdate(
  ctx: { userId: string; serverId: string },
  rowId: string,
  startVersion: number,
  data: Record<string, unknown>
): Promise<void> {
  let version = startVersion;
  for (let attempt = 0; attempt < VERSION_RETRIES; attempt++) {
    const res = await prisma.mcpConnection.updateMany({
      where: { id: rowId, version },
      data: { ...data, version: version + 1 },
    });
    if (res.count === 1) return;
    const fresh = await prisma.mcpConnection.findUnique({ where: { id: rowId } });
    if (!fresh) throw new McpTokenConflictError(ctx.userId, ctx.serverId);
    version = fresh.version;
  }
  throw new McpTokenConflictError(ctx.userId, ctx.serverId);
}

// ── Tokens ──────────────────────────────────────────────────────────────────

export interface SaveTokensInput {
  userId: string;
  serverId: string;
  url: string;
  transport: McpTransport;
  issuer?: string;
  tokens: StoredOAuthTokens;
}

function tokenMeta(tokens: StoredOAuthTokens): {
  tokenType: string | null;
  scope: string | null;
  expiresAt: Date | null;
} {
  const expiresIn = typeof tokens.expires_in === "number" ? tokens.expires_in : null;
  return {
    tokenType: tokens.token_type ?? null,
    scope: tokens.scope ?? null,
    expiresAt: expiresIn !== null ? new Date(Date.now() + expiresIn * 1000) : null,
  };
}

export async function saveConnectionTokens(input: SaveTokensInput): Promise<void> {
  const { userId, serverId } = input;
  await withConnectionLock(lockKey(userId, serverId), async () => {
    const issuer = input.issuer ?? input.tokens.issuer ?? null;
    const meta = tokenMeta(input.tokens);
    const data = {
      url: input.url,
      transport: input.transport,
      status: "connected",
      issuer,
      tokensCiphertext: encryptKey(JSON.stringify({ ...input.tokens, issuer: issuer ?? undefined })),
      ...meta,
      failureReason: null,
    };
    const row = await ensureConnectionRow(userId, serverId, { url: input.url, transport: input.transport });
    await versionedUpdate({ userId, serverId }, row.id, row.version, data);
  });
}

/** Decrypt this connection's tokens. Missing/corrupt rows → undefined. */
export async function loadConnectionTokens(userId: string, serverId: string): Promise<StoredOAuthTokens | undefined> {
  const row = await findConnection(userId, serverId);
  if (!row?.tokensCiphertext) return undefined;
  try {
    return JSON.parse(decryptKey(row.tokensCiphertext)) as StoredOAuthTokens;
  } catch {
    return undefined;
  }
}

/**
 * Refresh failed with a dead grant (or the server invalidated creds):
 * wipe the ciphertext and flag the row so the UI shows "reconnect".
 */
export async function markNeedsReauth(userId: string, serverId: string, reason?: string): Promise<void> {
  await withConnectionLock(lockKey(userId, serverId), async () => {
    const row = await findConnection(userId, serverId);
    if (!row) return;
    await versionedUpdate({ userId, serverId }, row.id, row.version, {
      status: "needs_reauth",
      tokensCiphertext: null,
      tokenType: null,
      expiresAt: null,
      failureReason: (reason ?? "authorization revoked").slice(0, 300),
    });
  });
}

export async function setConnectionTestResult(userId: string, serverId: string, ok: boolean): Promise<void> {
  await withConnectionLock(lockKey(userId, serverId), async () => {
    const row = await findConnection(userId, serverId);
    if (!row) return;
    await versionedUpdate({ userId, serverId }, row.id, row.version, {
      lastTestAt: new Date(),
      lastTestOk: ok,
    });
  });
}

// ── Connectors-panel settings (spec Phase 7) ─────────────────────────────────

/**
 * C6 SDK-lane twin of the browser lane's orplex.mcp.prefs.v1 toggle: the
 * auto-approve-read-only permission for one connector. A plain column
 * update - it neither bumps `version` nor touches token/client columns, so
 * it cannot race the guarded token writes above.
 * Returns false when no such connection exists.
 */
export async function setConnectionAutoApprove(userId: string, serverId: string, value: boolean): Promise<boolean> {
  const res = await prisma.mcpConnection.updateMany({
    where: { userId, serverId },
    data: { autoApproveReadOnly: value },
  });
  return res.count > 0;
}

/**
 * Disconnect: wipe tokens + client registration in place. The row and its
 * auto-approve preference survive so reconnect keeps settings; the
 * ciphertext never does.
 */
export async function disconnectConnection(userId: string, serverId: string): Promise<boolean> {
  return withConnectionLock(lockKey(userId, serverId), async () => {
    const row = await findConnection(userId, serverId);
    if (!row) return false;
    await versionedUpdate({ userId, serverId }, row.id, row.version, {
      status: "disconnected",
      tokensCiphertext: null,
      tokenType: null,
      expiresAt: null,
      clientId: null,
      clientSecret: null,
      failureReason: null,
    });
    return true;
  });
}

// ── Client registration (DCR) ───────────────────────────────────────────────

export interface SaveCredentialsInput {
  userId: string;
  serverId: string;
  url: string;
  transport: McpTransport;
  issuer?: string;
  clientId: string;
  clientSecret?: string;
}

export async function saveConnectionCredentials(input: SaveCredentialsInput): Promise<void> {
  const { userId, serverId } = input;
  await withConnectionLock(lockKey(userId, serverId), async () => {
    const data: Record<string, unknown> = {
      clientId: input.clientId,
      clientSecret: input.clientSecret ? encryptKey(input.clientSecret) : null,
      failureReason: null,
    };
    if (input.issuer) data.issuer = input.issuer;
    const row = await ensureConnectionRow(userId, serverId, { url: input.url, transport: input.transport });
    await versionedUpdate({ userId, serverId }, row.id, row.version, data);
  });
}

/**
 * Registered client for this authorization server. issuer-mismatched rows
 * are NOT handed out (RFC 6749 §2.2 — client ids are per-AS).
 */
export async function loadConnectionCredentials(
  userId: string,
  serverId: string,
  issuer?: string
): Promise<StoredOAuthClientInformation | undefined> {
  const row = await findConnection(userId, serverId);
  if (!row?.clientId) return undefined;
  if (issuer && row.issuer && row.issuer !== issuer) return undefined;
  const out: StoredOAuthClientInformation = { client_id: row.clientId };
  if (row.issuer) out.issuer = row.issuer;
  if (row.clientSecret) {
    try {
      out.client_secret = decryptKey(row.clientSecret);
    } catch {
      return undefined;
    }
  }
  return out;
}

/** Row WITHOUT ciphertext columns — safe for API responses / UI badges. */
export interface SafeConnection {
  serverId: string;
  url: string;
  transport: string;
  status: McpConnectionStatus;
  issuer: string | null;
  scope: string | null;
  expiresAt: Date | null;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  autoApproveReadOnly: boolean;
  failureReason: string | null;
  updatedAt: Date;
}

export async function listConnections(userId: string): Promise<SafeConnection[]> {
  const rows = await prisma.mcpConnection.findMany({ where: { userId }, orderBy: { serverId: "asc" } });
  return rows.map((r) => ({
    serverId: r.serverId,
    url: r.url,
    transport: r.transport,
    status: r.status as McpConnectionStatus,
    issuer: r.issuer,
    scope: r.scope,
    expiresAt: r.expiresAt,
    lastTestAt: r.lastTestAt,
    lastTestOk: r.lastTestOk,
    autoApproveReadOnly: r.autoApproveReadOnly,
    failureReason: r.failureReason ?? null,
    updatedAt: r.updatedAt,
  }));
}

export async function getConnection(userId: string, serverId: string) {
  return findConnection(userId, serverId);
}
