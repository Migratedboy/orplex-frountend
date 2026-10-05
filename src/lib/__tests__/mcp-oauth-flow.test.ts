// Unit tests for the MCP OAuth flow (spec Phase 3): redirect_uri policy,
// start (awaiting_browser / already-connected / typed failures), and
// complete (single-use state claims, session binding, denied/issuer/exchange
// failures, connected path). SDK + catalog are mocked; Prisma is mocked.

import { UnauthorizedError } from "@modelcontextprotocol/client";
import { prisma } from "@/lib/prisma";
import { getMcpCatalogEntry } from "@/lib/mcp-catalog";

jest.mock("@/lib/prisma", () => ({
  prisma: {
    mcpConnection: {
      findUnique: jest.fn(),
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

jest.mock("@/lib/mcp-catalog", () => {
  const actual = jest.requireActual("@/lib/mcp-catalog");
  return { ...actual, getMcpCatalogEntry: jest.fn() };
});

jest.mock("@modelcontextprotocol/client", () => {
  const actual = jest.requireActual("@modelcontextprotocol/client");
  return {
    ...actual,
    Client: jest.fn(),
    StreamableHTTPClientTransport: jest.fn(),
    SSEClientTransport: jest.fn(),
  };
});

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  completeAuthorization,
  hostedCallbackUrl,
  isLoopbackRedirect,
  resolveRedirectUri,
  startAuthorization,
} from "@/lib/mcp/oauth/flow";
import { PENDING_TTL_MS } from "@/lib/mcp/oauth/pending";

const conn = prisma.mcpConnection as jest.Mocked<typeof prisma.mcpConnection>;
const pend = prisma.mcpOAuthPending as jest.Mocked<typeof prisma.mcpOAuthPending>;
const catalogEntry = getMcpCatalogEntry as jest.MockedFunction<typeof getMcpCatalogEntry>;
const ClientMock = Client as unknown as jest.Mock;
const TransportMock = StreamableHTTPClientTransport as unknown as jest.Mock;

/** Typed, undefined-safe access to a mock call's first argument. */
function arg<T>(calls: ReadonlyArray<unknown[]>, index = 0): T {
  return (calls[index] ?? [])[0] as T;
}

const USER = "user_flow_1";
const ORIGIN = "http://localhost:5000";
const HOSTED = `${ORIGIN}/api/mcp/oauth/callback`;

const REMOTE_ENTRY = {
  id: "acme-cloud",
  name: "Acme Cloud",
  description: "Acme remote MCP server for testing.",
  category: "cloud" as const,
  auth: "oauth" as const,
  remote: { url: "https://mcp.acme.dev/mcp", transport: "streamable-http" as const },
  oauth: { scopes: ["read", "write"] },
  popular: true,
};

const TOKEN_ENTRY = {
  id: "supabase",
  name: "Supabase",
  description: "Supabase project tools over stdio.",
  category: "database" as const,
  auth: "token" as const,
  stdio: { command: "npx", args: ["-y", "pkg"], env: [] },
};

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pend_1",
    userId: USER,
    serverId: "acme-cloud",
    state: "s".repeat(43),
    codeVerifier: "verifier_1",
    redirectUrl: HOSTED,
    authorizationUrl: null,
    issuer: null,
    discoveryState: null,
    status: "consumed",
    consumedAt: new Date(),
    expiresAt: new Date(Date.now() + PENDING_TTL_MS),
    version: 2,
    failureReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

let connectMock: jest.Mock;
let closeMock: jest.Mock;
let finishAuthMock: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  connectMock = jest.fn().mockResolvedValue(undefined);
  closeMock = jest.fn().mockResolvedValue(undefined);
  finishAuthMock = jest.fn().mockResolvedValue(undefined);
  ClientMock.mockImplementation(() => ({ connect: connectMock, close: closeMock }));
  TransportMock.mockImplementation((_url: URL, opts: { authProvider: unknown }) => ({
    finishAuth: finishAuthMock,
    authProvider: opts.authProvider,
  }));
  conn.findUnique.mockResolvedValue(null as never);
  conn.create.mockResolvedValue({} as never);
  conn.updateMany.mockResolvedValue({ count: 1 } as never);
  catalogEntry.mockImplementation((id: string) => {
    if (id === REMOTE_ENTRY.id) return REMOTE_ENTRY;
    if (id === TOKEN_ENTRY.id) return TOKEN_ENTRY;
    return null;
  });
});

// ── redirect_uri policy ─────────────────────────────────────────────────────

describe("redirect_uri policy", () => {
  it("defaults to the hosted callback", () => {
    expect(resolveRedirectUri(undefined, ORIGIN)).toBe(HOSTED);
    expect(hostedCallbackUrl("http://localhost:5000/")).toBe(HOSTED);
  });

  it("accepts the exact hosted callback and RFC 8252 loopback", () => {
    expect(resolveRedirectUri(HOSTED, ORIGIN)).toBe(HOSTED);
    expect(resolveRedirectUri("http://127.0.0.1:45173/callback", ORIGIN)).toBe("http://127.0.0.1:45173/callback");
    expect(resolveRedirectUri("http://localhost:9999/callback", ORIGIN)).toBe("http://localhost:9999/callback");
    expect(isLoopbackRedirect("http://127.0.0.1:1/callback")).toBe(true);
  });

  it.each([
    "https://127.0.0.1/callback", // loopback must be http (our listener is plain http)
    "http://127.0.0.1:45173/steal", // wrong path
    "http://192.168.1.50/callback", // not loopback
    "http://evil.com/callback", // external
    "http://user:pass@127.0.0.1/callback", // embedded credentials
    "not-a-url",
  ])("rejects %s", (uri) => {
    expect(resolveRedirectUri(uri, ORIGIN)).toBeNull();
    expect(isLoopbackRedirect(uri)).toBe(false);
  });
});

// ── start ───────────────────────────────────────────────────────────────────

describe("startAuthorization", () => {
  it("refuses stdio/token-only entries with a typed error (no pending row)", async () => {
    pend.create.mockClear();
    const res = await startAuthorization({ userId: USER, serverId: "supabase", redirectUri: HOSTED });
    expect(res).toMatchObject({ status: "error", code: "no_remote" });
    expect(pend.create).not.toHaveBeenCalled();
  });

  it("returns awaiting_browser with a captured auth URL after the 401 leg", async () => {
    pend.create.mockResolvedValue({ id: "p1" } as never);
    pend.update.mockResolvedValue(pendingRow({ status: "pending", consumedAt: null }) as never);

    connectMock.mockImplementation(async () => {
      const transport = TransportMock.mock.results[TransportMock.mock.calls.length - 1].value as {
        authProvider: { redirectToAuthorization(url: URL): Promise<void> };
      };
      await transport.authProvider.redirectToAuthorization(new URL("https://auth.acme.dev/authorize?client_id=c1"));
      throw new UnauthorizedError();
    });

    const res = await startAuthorization({ userId: USER, serverId: "acme-cloud", redirectUri: HOSTED });
    expect(res.status).toBe("awaiting_browser");
    if (res.status !== "awaiting_browser") throw new Error("unreachable");
    expect(res.authUrl).toContain("https://auth.acme.dev/authorize");
    expect(res.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.expiresAt).toBeGreaterThan(Date.now() + PENDING_TTL_MS - 5000);
    // pending row got the authorization URL (server-side record, one read for the UI)
    expect(pend.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ authorizationUrl: expect.stringContaining("auth.acme.dev") }) })
    );
    expect(closeMock).toHaveBeenCalledTimes(1); // client closed on every path
  });

  it("reports connected when stored tokens already authorize the server", async () => {
    pend.create.mockResolvedValue({ id: "p1" } as never);
    const res = await startAuthorization({ userId: USER, serverId: "acme-cloud", redirectUri: HOSTED });
    expect(res).toEqual({ status: "connected" });
  });

  it("maps DCR rejection to the typed static-client error", async () => {
    pend.create.mockResolvedValue({ id: "p1" } as never);
    connectMock.mockRejectedValue(Object.assign(new Error("registration rejected"), { name: "RegistrationRejectedError" }));
    const res = await startAuthorization({ userId: USER, serverId: "acme-cloud", redirectUri: HOSTED });
    expect(res).toMatchObject({ status: "error", code: "mcp_static_client_required" });
  });

  it("maps unreachable servers to a network error", async () => {
    pend.create.mockResolvedValue({ id: "p1" } as never);
    connectMock.mockRejectedValue(new TypeError("fetch failed"));
    const res = await startAuthorization({ userId: USER, serverId: "acme-cloud", redirectUri: HOSTED });
    expect(res).toMatchObject({ status: "error", code: "network" });
  });

  it("errors honestly if 401 came without a redirect URL", async () => {
    pend.create.mockResolvedValue({ id: "p1" } as never);
    connectMock.mockRejectedValue(new UnauthorizedError());
    const res = await startAuthorization({ userId: USER, serverId: "acme-cloud", redirectUri: HOSTED });
    expect(res).toMatchObject({ status: "error", code: "oauth_failed" });
  });
});

// ── complete ────────────────────────────────────────────────────────────────

describe("completeAuthorization", () => {
  function claimMiss(reasonRow: Record<string, unknown> | null) {
    pend.updateMany.mockResolvedValueOnce({ count: 0 } as never);
    pend.findUnique.mockResolvedValueOnce(reasonRow as never);
  }

  it("rejects unknown, expired, and replayed states with typed codes", async () => {
    claimMiss(null);
    expect(await completeAuthorization({ userId: USER, state: "nope", params: new URLSearchParams() })).toMatchObject({
      status: "error",
      code: "state_unknown",
    });

    claimMiss(pendingRow({ status: "pending", consumedAt: null, expiresAt: new Date(Date.now() - 1000) }));
    expect(await completeAuthorization({ userId: USER, state: "s", params: new URLSearchParams() })).toMatchObject({
      status: "error",
      code: "state_expired",
    });

    claimMiss(pendingRow());
    const replay = await completeAuthorization({ userId: USER, state: "s", params: new URLSearchParams() });
    expect(replay).toMatchObject({ status: "error", code: "state_used" });
    if (replay.status !== "error") throw new Error("unreachable");
    expect(replay.error).toContain("already used");
  });

  it("binds the claimed state to the session user", async () => {
    pend.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    pend.findUnique.mockResolvedValueOnce(pendingRow({ userId: "someone_else" }) as never);
    pend.updateMany.mockResolvedValueOnce({ count: 1 } as never); // failPending
    const res = await completeAuthorization({ userId: USER, state: "s", params: new URLSearchParams() });
    expect(res).toMatchObject({ status: "error", code: "wrong_owner" });
  });

  it("records an AS-side denial (user clicked cancel)", async () => {
    pend.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    pend.findUnique.mockResolvedValueOnce(pendingRow() as never);
    pend.updateMany.mockResolvedValueOnce({ count: 1 } as never); // failPending
    const params = new URLSearchParams({ error: "access_denied", error_description: "User declined", state: "s" });
    const res = await completeAuthorization({ userId: USER, state: "s", params });
    expect(res).toMatchObject({ status: "error", code: "denied" });
    if (res.status !== "error") throw new Error("unreachable");
    expect(res.error).toContain("User declined");
    const failCall = arg<{ data: { failureReason: string } }>(pend.updateMany.mock.calls, 1);
    expect(failCall.data.failureReason).toContain("authorization denied");
  });

  it("exchanges the whole callback through finishAuth and verifies the session", async () => {
    pend.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    pend.findUnique.mockResolvedValueOnce(pendingRow() as never);

    const params = new URLSearchParams({ code: "auth_code_1", state: "s".repeat(43), iss: "https://auth.acme.dev" });
    const res = await completeAuthorization({ userId: USER, state: "s".repeat(43), params });

    expect(res).toEqual({ status: "connected", serverId: "acme-cloud" });
    expect(finishAuthMock).toHaveBeenCalledTimes(1);
    expect(finishAuthMock.mock.calls[0][0].get("code")).toBe("auth_code_1");
    expect(connectMock).toHaveBeenCalledTimes(1); // verify leg
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("fails the pending row when the exchange fails", async () => {
    pend.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    pend.findUnique.mockResolvedValueOnce(pendingRow() as never);
    finishAuthMock.mockRejectedValueOnce(new Error("invalid_grant: refresh unsupported"));
    pend.updateMany.mockResolvedValueOnce({ count: 1 } as never); // failPending

    const res = await completeAuthorization({
      userId: USER,
      state: "s".repeat(43),
      params: new URLSearchParams({ code: "c", state: "s".repeat(43) }),
    });
    expect(res).toMatchObject({ status: "error", code: "exchange_failed" });
    const failCall = arg<{ where: { id: string; version: number }; data: { failureReason: string } }>(pend.updateMany.mock.calls, 1);
    expect(failCall.where).toMatchObject({ id: "pend_1", version: 2 });
    expect(failCall.data.failureReason).toContain("invalid_grant");
    expect(connectMock).not.toHaveBeenCalled(); // verify leg skipped after failure
  });

  it("maps an RFC 9207 issuer mismatch to its own code", async () => {
    pend.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    pend.findUnique.mockResolvedValueOnce(pendingRow() as never);
    finishAuthMock.mockRejectedValueOnce(Object.assign(new Error("iss did not match"), { name: "IssuerMismatchError" }));
    pend.updateMany.mockResolvedValueOnce({ count: 1 } as never);

    const res = await completeAuthorization({ userId: USER, state: "s".repeat(43), params: new URLSearchParams({ code: "c", state: "s" }) });
    expect(res).toMatchObject({ status: "error", code: "issuer_mismatch" });
  });

  it("surfaces a verify failure honestly (signed in but server rejects)", async () => {
    pend.updateMany.mockResolvedValueOnce({ count: 1 } as never);
    pend.findUnique.mockResolvedValueOnce(pendingRow() as never);
    connectMock.mockRejectedValueOnce(new UnauthorizedError());

    const res = await completeAuthorization({
      userId: USER,
      state: "s".repeat(43),
      params: new URLSearchParams({ code: "c", state: "s".repeat(43) }),
    });
    expect(res).toMatchObject({ status: "error", code: "verify_failed" });
    if (res.status !== "error") throw new Error("unreachable");
    expect(res.error).toContain("rejected the session");
  });
});
