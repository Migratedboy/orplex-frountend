// Unit tests for MCP OAuth persistence (spec Phase 2), all against a mocked
// Prisma: one-time pending claims (single-use/expiry), the token store's
// mutex + optimistic version guard, ciphertext-at-rest, needs_reauth, and
// the provider's typed no-DCR error.

import { decryptKey, encryptKey } from "@/lib/key-encryption";
import { prisma } from "@/lib/prisma";

jest.mock("@/lib/prisma", () => ({
  prisma: {
    mcpConnection: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    mcpOAuthPending: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
  },
}));

import {
  McpTokenConflictError,
  disconnectConnection,
  listConnections,
  loadConnectionCredentials,
  loadConnectionTokens,
  markNeedsReauth,
  saveConnectionCredentials,
  saveConnectionTokens,
  setConnectionAutoApprove,
  withConnectionLock,
} from "@/lib/mcp/oauth/store";
import {
  PENDING_TTL_MS,
  claimPending,
  createPending,
  failPending,
  sweepExpiredPendings,
} from "@/lib/mcp/oauth/pending";
import { DbMcpOAuthProvider, McpStaticClientRequiredError } from "@/lib/mcp/oauth/provider";

const conn = prisma.mcpConnection as jest.Mocked<typeof prisma.mcpConnection>;
const pend = prisma.mcpOAuthPending as jest.Mocked<typeof prisma.mcpOAuthPending>;

/** Typed, undefined-safe access to a mock call's first argument. */
function arg<T>(calls: ReadonlyArray<unknown[]>, index = 0): T {
  return (calls[index] ?? [])[0] as T;
}

const USER = "user_oauth_1";
const SERVER = "github";

const TOKENS = {
  access_token: "at_super_secret_value",
  token_type: "Bearer",
  refresh_token: "rt_super_secret_value",
  expires_in: 3600,
  scope: "repo read:org",
} as const;

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn_1",
    userId: USER,
    serverId: SERVER,
    transport: "streamable-http",
    url: "https://api.githubcopilot.com/mcp/",
    status: "disconnected",
    issuer: null,
    clientId: null,
    clientSecret: null,
    tokensCiphertext: null,
    tokenType: null,
    scope: null,
    expiresAt: null,
    version: 1,
    lastTestAt: null,
    lastTestOk: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pend_1",
    userId: USER,
    serverId: SERVER,
    state: "state_abc",
    codeVerifier: null,
    redirectUrl: "http://127.0.0.1:45173/callback",
    authorizationUrl: null,
    issuer: null,
    discoveryState: null,
    status: "pending",
    consumedAt: null,
    expiresAt: new Date(Date.now() + PENDING_TTL_MS),
    version: 1,
    failureReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── pending: one-time state ─────────────────────────────────────────────────

describe("createPending/claimPending", () => {
  it("creates a high-entropy single-use state with a TTL", async () => {
    pend.create.mockResolvedValue(pendingRow() as never);
    const out = await createPending({ userId: USER, serverId: SERVER, redirectUrl: "http://127.0.0.1:1/callback" });
    expect(out.state).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    const data = arg<{ data: { userId: string; serverId: string; expiresAt: Date } }>(pend.create.mock.calls).data;
    expect(data.userId).toBe(USER);
    expect(data.serverId).toBe(SERVER);
    expect(data.expiresAt.getTime()).toBeGreaterThan(Date.now() + PENDING_TTL_MS - 5000);
    expect(data.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + PENDING_TTL_MS);
  });

  it("claims a pending row exactly once (replay → used)", async () => {
    pend.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    pend.findUnique.mockResolvedValueOnce(pendingRow({ status: "consumed", consumedAt: new Date(), version: 2 }) as never);

    const first = await claimPending("state_abc");
    expect(first.ok).toBe(true);
    const guard = arg<{ where: { status: string; consumedAt: Date | null; expiresAt: { gt: Date } } }>(pend.updateMany.mock.calls).where;
    expect(guard.status).toBe("pending");
    expect(guard.consumedAt).toBeNull();
    expect(guard.expiresAt.gt).toBeInstanceOf(Date);

    // Replay: updateMany misses, row shows consumed.
    pend.updateMany.mockResolvedValueOnce({ count: 0 } as never);
    pend.findUnique.mockResolvedValueOnce(pendingRow({ status: "consumed", consumedAt: new Date() }) as never);
    const second = await claimPending("state_abc");
    expect(second).toEqual({ ok: false, reason: "used" });
  });

  it("rejects expired and unknown states with typed reasons", async () => {
    pend.updateMany.mockResolvedValue({ count: 0 } as never);

    pend.findUnique.mockResolvedValueOnce(pendingRow({ expiresAt: new Date(Date.now() - 1000) }) as never);
    expect(await claimPending("state_abc")).toEqual({ ok: false, reason: "expired" });

    pend.findUnique.mockResolvedValueOnce(null as never);
    expect(await claimPending("nope")).toEqual({ ok: false, reason: "unknown" });
  });

  it("failPending is version-guarded (stale writer loses)", async () => {
    pend.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    expect(await failPending("pend_1", 2, "exchange failed")).toBe(true);
    const call = arg<{ where: Record<string, unknown>; data: { version: number } }>(pend.updateMany.mock.calls);
    expect(call.where).toMatchObject({ id: "pend_1", version: 2, status: "consumed" });
    expect(call.data.version).toBe(3);

    pend.updateMany.mockResolvedValueOnce({ count: 0 } as never);
    expect(await failPending("pend_1", 1, "stale")).toBe(false);
  });

  it("sweeps pendings well past their TTL", async () => {
    pend.deleteMany.mockResolvedValueOnce({ count: 4 } as never);
    expect(await sweepExpiredPendings()).toBe(4);
    expect(arg<{ where: { expiresAt: { lt: Date } } }>(pend.deleteMany.mock.calls).where.expiresAt.lt).toBeInstanceOf(Date);
  });
});

// ── store: mutex, version, ciphertext ───────────────────────────────────────

describe("withConnectionLock", () => {
  it("serializes concurrent work per key", async () => {
    const order: string[] = [];
    const slow = withConnectionLock("k", async () => {
      await new Promise((r) => setTimeout(r, 15));
      order.push("a-end");
    });
    const fast = withConnectionLock("k", async () => {
      order.push("b-start");
    });
    order.push("a-start");
    await Promise.all([slow, fast]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  it("a rejected section does not wedge the queue", async () => {
    await expect(withConnectionLock("k2", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(withConnectionLock("k2", async () => "next")).resolves.toBe("next");
  });
});

describe("saveConnectionTokens", () => {
  it("stores tokens as ciphertext only (never plaintext at rest)", async () => {
    conn.findUnique.mockResolvedValue(connectionRow() as never);
    conn.updateMany.mockResolvedValue({ count: 1 } as never);

    await saveConnectionTokens({ userId: USER, serverId: SERVER, url: "https://x/mcp", transport: "streamable-http", tokens: TOKENS as never });

    const data = arg<{ data: Record<string, unknown> }>(conn.updateMany.mock.calls).data;
    const cipher = data.tokensCiphertext as string;
    expect(typeof cipher).toBe("string");
    expect(cipher).not.toContain(TOKENS.access_token);
    expect(cipher).not.toContain(TOKENS.refresh_token);
    expect(data.status).toBe("connected");
    expect(data.tokenType).toBe("Bearer");
    expect(data.scope).toBe("repo read:org");
    expect(data.expiresAt).toBeInstanceOf(Date);
    // round-trip through load
    conn.findUnique.mockResolvedValue(connectionRow({ tokensCiphertext: cipher }) as never);
    const loaded = await loadConnectionTokens(USER, SERVER);
    expect(loaded?.access_token).toBe(TOKENS.access_token);
    expect(loaded?.refresh_token).toBe(TOKENS.refresh_token);
  });

  it("optimistic guard: WHERE id+version, bump on write", async () => {
    conn.findUnique.mockResolvedValue(connectionRow({ version: 3 }) as never);
    conn.updateMany.mockResolvedValue({ count: 1 } as never);

    await saveConnectionTokens({ userId: USER, serverId: SERVER, url: "https://x/mcp", transport: "streamable-http", tokens: TOKENS as never });

    const call = arg<{ where: { id: string; version: number }; data: { version: number } }>(conn.updateMany.mock.calls);
    expect(call.where).toMatchObject({ id: "conn_1", version: 3 });
    expect(call.data.version).toBe(4);
  });

  it("retries against the fresh version after a lost race", async () => {
    conn.findUnique
      .mockResolvedValueOnce(connectionRow({ version: 3 }) as never)
      .mockResolvedValueOnce(connectionRow({ id: "conn_1", version: 5 }) as never);
    conn.updateMany
      .mockResolvedValueOnce({ count: 0 } as never) // stale writer loses
      .mockResolvedValueOnce({ count: 1 } as never); // re-read version 5 wins

    await saveConnectionTokens({ userId: USER, serverId: SERVER, url: "https://x/mcp", transport: "streamable-http", tokens: TOKENS as never });

    expect(conn.updateMany).toHaveBeenCalledTimes(2);
    expect(arg<{ where: { version: number } }>(conn.updateMany.mock.calls, 0).where.version).toBe(3);
    expect(arg<{ where: { version: number } }>(conn.updateMany.mock.calls, 1).where.version).toBe(5);
  });

  it("fails typed when the version guard exhausts its retries", async () => {
    conn.findUnique.mockResolvedValue(connectionRow({ version: 2 }) as never);
    conn.updateMany.mockResolvedValue({ count: 0 } as never);

    await expect(
      saveConnectionTokens({ userId: USER, serverId: SERVER, url: "https://x/mcp", transport: "streamable-http", tokens: TOKENS as never })
    ).rejects.toThrow(McpTokenConflictError);
    expect(conn.updateMany).toHaveBeenCalledTimes(3);
  });
});

describe("needs_reauth + credentials", () => {
  it("markNeedsReauth wipes the ciphertext and flags the row", async () => {
    conn.findUnique.mockResolvedValue(connectionRow({ version: 7, tokensCiphertext: "deadbeef" }) as never);
    conn.updateMany.mockResolvedValue({ count: 1 } as never);

    await markNeedsReauth(USER, SERVER, "invalid_grant");

    const call = arg<{ where: { version: number }; data: Record<string, unknown> }>(conn.updateMany.mock.calls);
    expect(call.where).toMatchObject({ id: "conn_1", version: 7 });
    expect(call.data).toMatchObject({ status: "needs_reauth", tokensCiphertext: null, version: 8, failureReason: "invalid_grant" });

    // After the wipe, no tokens come back.
    conn.findUnique.mockResolvedValue(connectionRow({ version: 8, status: "needs_reauth", tokensCiphertext: null }) as never);
    expect(await loadConnectionTokens(USER, SERVER)).toBeUndefined();
  });

  it("client credentials are encrypted and issuer-checked on read", async () => {
    conn.findUnique.mockResolvedValue(connectionRow() as never);
    conn.updateMany.mockResolvedValue({ count: 1 } as never);

    await saveConnectionCredentials({
      userId: USER,
      serverId: SERVER,
      url: "https://x/mcp",
      transport: "streamable-http",
      issuer: "https://auth.example.com",
      clientId: "client_123",
      clientSecret: "shh_dcr_secret",
    });

    const data = arg<{ data: Record<string, unknown> }>(conn.updateMany.mock.calls).data;
    expect(data.clientSecret).not.toContain("shh_dcr_secret");
    expect(decryptKey(data.clientSecret as string)).toBe("shh_dcr_secret"); // random IV: round-trip, not equality

    const row = connectionRow({ clientId: "client_123", clientSecret: encryptKey("shh_dcr_secret"), issuer: "https://auth.example.com" });
    conn.findUnique.mockResolvedValue(row as never);
    const sameIssuer = await loadConnectionCredentials(USER, SERVER, "https://auth.example.com");
    expect(sameIssuer).toMatchObject({ client_id: "client_123", client_secret: "shh_dcr_secret" });
    const otherIssuer = await loadConnectionCredentials(USER, SERVER, "https://evil.example.com");
    expect(otherIssuer).toBeUndefined();
  });
});

// ── provider: SDK surface ───────────────────────────────────────────────────

function provider(overrides: Record<string, unknown> = {}) {
  return new DbMcpOAuthProvider({
    userId: USER,
    serverId: SERVER,
    pendingState: "state_abc",
    endpointUrl: "https://x/mcp",
    transport: "streamable-http",
    redirectUrl: "http://127.0.0.1:45173/callback",
    clientName: "GitHub",
    scopes: ["repo", "read:org"],
    ...overrides,
  });
}

describe("DbMcpOAuthProvider", () => {
  it("builds DCR client metadata with our exact redirect_uri and scopes", () => {
    const md = provider().clientMetadata;
    expect(md.redirect_uris).toEqual(["http://127.0.0.1:45173/callback"]);
    expect(md.scope).toBe("repo read:org");
    expect(md.client_name).toContain("Orplex");
    expect(md.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(provider().state()).toBe("state_abc");
  });

  it("returns undefined client info to let the SDK dynamic-register", async () => {
    conn.findUnique.mockResolvedValue(connectionRow() as never); // no client id
    expect(await provider().clientInformation({ issuer: "https://auth.example.com" })).toBeUndefined();
  });

  it("prefers the catalog static client id when DCR is unavailable", async () => {
    conn.findUnique.mockResolvedValue(connectionRow() as never);
    const info = await provider({ staticClientId: "static_client_9" }).clientInformation({ issuer: "https://auth.example.com" });
    expect(info).toEqual({ client_id: "static_client_9", issuer: "https://auth.example.com" });
  });

  it("throws the typed no-DCR error instead of attempting registration", async () => {
    conn.findUnique.mockResolvedValue(connectionRow() as never);
    const p = provider({ allowDynamicRegistration: false });
    await expect(p.clientInformation({ issuer: "https://auth.example.com" })).rejects.toThrow(McpStaticClientRequiredError);
    await expect(p.clientInformation({ issuer: "https://auth.example.com" })).rejects.toMatchObject({
      code: "mcp_static_client_required",
      serverId: SERVER,
    });
  });

  it("persists the PKCE verifier on the pending row and reads it back", async () => {
    pend.update.mockResolvedValue(pendingRow({ codeVerifier: "ver_1" }) as never);
    const p = provider();
    await p.saveCodeVerifier("ver_1");
    expect(arg<{ where: Record<string, unknown>; data: Record<string, unknown> }>(pend.update.mock.calls)).toMatchObject({
      where: { state: "state_abc" },
      data: { codeVerifier: "ver_1" },
    });

    pend.findUnique.mockResolvedValue(pendingRow({ codeVerifier: "ver_1" }) as never);
    expect(await p.codeVerifier()).toBe("ver_1");

    pend.findUnique.mockResolvedValue(pendingRow({ codeVerifier: null }) as never);
    await expect(p.codeVerifier()).rejects.toMatchObject({ name: "McpPendingVerifierMissing" });
  });

  it("captures the authorization URL without opening anything", async () => {
    pend.update.mockResolvedValue(pendingRow() as never);
    const p = provider();
    const url = new URL("https://auth.example.com/authorize?state=state_abc");
    await p.redirectToAuthorization(url);
    expect(p.authorizationUrl).toBe(url.toString());
    expect(arg<{ data: { authorizationUrl: string } }>(pend.update.mock.calls).data.authorizationUrl).toBe(url.toString());
  });

  it("invalidating tokens marks the connection needs_reauth", async () => {
    conn.findUnique.mockResolvedValue(connectionRow({ version: 2 }) as never);
    conn.updateMany.mockResolvedValue({ count: 1 } as never);
    await provider().invalidateCredentials("tokens");
    expect(arg<{ data: Record<string, unknown> }>(conn.updateMany.mock.calls).data).toMatchObject({ status: "needs_reauth", tokensCiphertext: null });
  });
});

// ── panel settings: toggle + disconnect (spec Phase 7) ──────────────────────

describe("panel settings (Phase 7)", () => {
  it("setConnectionAutoApprove updates only that column for the owning user", async () => {
    conn.updateMany.mockResolvedValue({ count: 1 } as never);
    await expect(setConnectionAutoApprove(USER, SERVER, true)).resolves.toBe(true);
    expect(arg<{ where: Record<string, unknown>; data: Record<string, unknown> }>(conn.updateMany.mock.calls)).toEqual({
      where: { userId: USER, serverId: SERVER },
      data: { autoApproveReadOnly: true },
    });
  });

  it("setConnectionAutoApprove reports a missing connection", async () => {
    conn.updateMany.mockResolvedValue({ count: 0 } as never);
    await expect(setConnectionAutoApprove(USER, "ghost", false)).resolves.toBe(false);
  });

  it("disconnectConnection wipes tokens + client registration but keeps the preference", async () => {
    conn.findUnique.mockResolvedValue(
      connectionRow({ version: 3, tokensCiphertext: "deadbeef", clientId: "c_1", clientSecret: "enc", autoApproveReadOnly: true }) as never
    );
    conn.updateMany.mockResolvedValue({ count: 1 } as never);

    await expect(disconnectConnection(USER, SERVER)).resolves.toBe(true);

    const call = arg<{ where: { version: number }; data: Record<string, unknown> }>(conn.updateMany.mock.calls);
    expect(call.where.version).toBe(3);
    expect(call.data).toMatchObject({
      status: "disconnected",
      tokensCiphertext: null,
      tokenType: null,
      expiresAt: null,
      clientId: null,
      clientSecret: null,
      failureReason: null,
    });
    expect(call.data).not.toHaveProperty("autoApproveReadOnly");
  });

  it("disconnectConnection reports a missing connection without writing", async () => {
    conn.findUnique.mockResolvedValue(null as never);
    await expect(disconnectConnection(USER, "ghost")).resolves.toBe(false);
    expect(conn.updateMany).not.toHaveBeenCalled();
  });

  it("listConnections surfaces the toggle + failure reason, never the ciphertext", async () => {
    conn.findMany.mockResolvedValue([
      connectionRow({ autoApproveReadOnly: true, failureReason: "invalid_grant", tokensCiphertext: "secret-cipher-value" }),
    ] as never);
    const rows = await listConnections(USER);
    expect(rows[0]).toMatchObject({ serverId: SERVER, autoApproveReadOnly: true, failureReason: "invalid_grant" });
    expect(JSON.stringify(rows)).not.toContain("secret-cipher-value");
  });
});
