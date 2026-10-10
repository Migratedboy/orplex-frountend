// pending.ts — one-time OAuth authorization states (spec Phase 2).
//
// A pending row is created before the browser round-trip and is SINGLE-USE:
// the callback leg must claim it (state match + not expired + not yet
// consumed) before the SDK exchanges the code. The one-time server-stored
// state doubles as the CSRF defense — there is no proxy CSRF layer to lean
// on (conflict C9), and the state/verifier/issuer/discovery JSON never leave
// the server.

import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";

/** Time-to-live for an un-completed authorization. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

export type PendingClaimReason = "unknown" | "expired" | "used" | "failed";

export type PendingClaimResult =
  | { ok: true; pending: NonNullable<Awaited<ReturnType<typeof prisma.mcpOAuthPending.findUnique>>> }
  | { ok: false; reason: PendingClaimReason };

/** Create the state correlation for one connect attempt. */
export async function createPending(input: {
  userId: string;
  serverId: string;
  redirectUrl: string;
  ttlMs?: number;
}): Promise<{ id: string; state: string }> {
  const state = randomBytes(32).toString("base64url");
  const row = await prisma.mcpOAuthPending.create({
    data: {
      userId: input.userId,
      serverId: input.serverId,
      state,
      redirectUrl: input.redirectUrl,
      expiresAt: new Date(Date.now() + (input.ttlMs ?? PENDING_TTL_MS)),
    },
  });
  return { id: row.id, state };
}

/**
 * Single-use claim for the callback leg. Only a pending, unexpired,
 * unconsumed row with a matching state flips to "consumed"; the caller then
 * owns the exchange. Failure reasons are typed so the route can map them to
 * honest HTTP errors (replay, expiry, unknown state).
 */
export async function claimPending(state: string): Promise<PendingClaimResult> {
  const now = new Date();
  const res = await prisma.mcpOAuthPending.updateMany({
    where: { state, status: "pending", consumedAt: null, expiresAt: { gt: now } },
    data: { status: "consumed", consumedAt: now, version: { increment: 1 } },
  });
  if (res.count === 1) {
    const pending = await prisma.mcpOAuthPending.findUnique({ where: { state } });
    if (pending) return { ok: true, pending };
    return { ok: false, reason: "unknown" };
  }
  const row = await prisma.mcpOAuthPending.findUnique({ where: { state } });
  if (!row) return { ok: false, reason: "unknown" };
  if (row.status === "failed") return { ok: false, reason: "failed" };
  if (row.consumedAt || row.status === "consumed") return { ok: false, reason: "used" };
  if (row.expiresAt <= now) return { ok: false, reason: "expired" };
  return { ok: false, reason: "unknown" };
}

/**
 * Record an exchange failure on a claimed row. Version-guarded so a
 * concurrent sweeper or second writer can't silently re-flag the same row.
 * Returns false when the caller's view was stale.
 */
export async function failPending(id: string, expectedVersion: number, reason: string): Promise<boolean> {
  const res = await prisma.mcpOAuthPending.updateMany({
    where: { id, version: expectedVersion, status: "consumed" },
    data: {
      status: "failed",
      failureReason: reason.slice(0, 300),
      version: expectedVersion + 1,
    },
  });
  return res.count === 1;
}

export async function getPendingByState(state: string) {
  return prisma.mcpOAuthPending.findUnique({ where: { state } });
}

/**
 * PKCE verifier for the current leg (server-side only; never logged).
 * Stored AES-encrypted like every other credential — a DB dump plus an
 * intercepted `code` must not yield a live exchange (10-min TTL alone is
 * not a credential boundary).
 */
export async function setPendingCodeVerifier(state: string, codeVerifier: string): Promise<void> {
  const { encryptKey } = await import("@/lib/key-encryption");
  await prisma.mcpOAuthPending.update({ where: { state }, data: { codeVerifier: encryptKey(codeVerifier) } });
}

/** Where the SDK sent the browser + resolved issuer (set pre-redirect). */
export async function setPendingAuthorization(
  state: string,
  patch: { authorizationUrl: string; issuer?: string }
): Promise<void> {
  await prisma.mcpOAuthPending.update({
    where: { state },
    data: { authorizationUrl: patch.authorizationUrl, ...(patch.issuer ? { issuer: patch.issuer } : {}) },
  });
}

/** Persist the SDK's discovery result (SEP-2352) for the callback leg. */
export async function setPendingDiscovery(state: string, discoveryState: unknown, issuer?: string): Promise<void> {
  await prisma.mcpOAuthPending.update({
    where: { state },
    data: { discoveryState: discoveryState as object, ...(issuer ? { issuer } : {}) },
  });
}

/** Housekeeping: drop pendings well past their TTL (nothing to claim). */
export async function sweepExpiredPendings(olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
  const res = await prisma.mcpOAuthPending.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - olderThanMs) } },
  });
  return res.count;
}
