// mcp-hub.test.ts — Phase 4 connection manager: status machine, single-flight
// connect, wrapping rules (timeouts/caps), backoff gate, needs_reauth mapping,
// and the SSRF fetch being handed to the transport.
import { UnauthorizedError } from "@modelcontextprotocol/client";

const mockClientHooks: {
  connectImpl: (client: unknown) => Promise<void>;
  closeImpl?: (client: unknown) => Promise<void> | void;
  listToolsImpl: (client: unknown) => Promise<unknown>;
  callToolImpl: (client: unknown, params: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
  instances: Array<{ closed: boolean }>;
  transports: Array<{ url: string; opts: Record<string, unknown> }>;
} = {
  connectImpl: async () => {},
  listToolsImpl: async () => ({ tools: [] }),
  callToolImpl: async () => ({ content: [{ type: "text", text: "ok" }] }),
  instances: [],
  transports: [],
};

jest.mock("@modelcontextprotocol/client", () => {
  const actual = jest.requireActual("@modelcontextprotocol/client");
  class MockClient {
    closed = false;
    constructor(_info: unknown) {
      mockClientHooks.instances.push(this);
    }
    async connect(_transport: unknown) {
      return mockClientHooks.connectImpl(this);
    }
    async close() {
      this.closed = true;
      return mockClientHooks.closeImpl?.(this);
    }
    async listTools(_opts?: unknown) {
      return mockClientHooks.listToolsImpl(this);
    }
    async callTool(params: { name: string; arguments: Record<string, unknown> }) {
      return mockClientHooks.callToolImpl(this, params);
    }
  }
  class MockStreamable {
    constructor(
      readonly url: URL,
      readonly opts?: Record<string, unknown>
    ) {
      mockClientHooks.transports.push({ url: url.toString(), opts: opts ?? {} });
    }
  }
  class MockSse extends MockStreamable {}
  return {
    ...actual,
    Client: MockClient,
    StreamableHTTPClientTransport: MockStreamable,
    SSEClientTransport: MockSse,
  };
});

jest.mock("@/lib/mcp-catalog", () => ({
  getMcpCatalogEntry: jest.fn(() => null),
}));

jest.mock("@/lib/mcp/oauth/store", () => ({
  loadConnectionCredentials: jest.fn(async () => undefined),
  loadConnectionTokens: jest.fn(async () => undefined),
  saveConnectionTokens: jest.fn(async () => {}),
  markNeedsReauth: jest.fn(async () => {}),
}));

import { getMcpCatalogEntry } from "@/lib/mcp-catalog";
import { markNeedsReauth } from "@/lib/mcp/oauth/store";
import {
  hubBackoffMs,
  hubCallTool,
  hubCloseServer,
  hubListTools,
  hubShutdown,
  hubStatus,
  HUB_BACKOFF_BASE_MS,
  HUB_MAX_INFLIGHT,
  McpHubError,
  RuntimeMcpOAuthProvider,
} from "../mcp/hub";
import { ssrfFetch } from "../mcp/ssrf-fetch";

const REMOTE_ENTRY = {
  id: "acme-cloud",
  name: "Acme Cloud",
  description: "Test remote MCP server.",
  category: "productivity" as const,
  auth: "oauth" as const,
  remote: { url: "https://mcp.acme.test/mcp", transport: "streamable-http" as const },
  stdio: { command: "npx", args: [], env: [] },
  oauth: { scopes: ["read"] },
};

const USER = "user_1";

function mockCatalog(entry: unknown) {
  (getMcpCatalogEntry as jest.Mock).mockReturnValue(entry);
}

function errCode(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => "resolved",
    (e) => (e instanceof McpHubError ? e.code : `other:${(e as Error).message}`)
  );
}

beforeEach(() => {
  mockClientHooks.connectImpl = async () => {};
  mockClientHooks.closeImpl = undefined;
  mockClientHooks.listToolsImpl = async () => ({ tools: [] });
  mockClientHooks.callToolImpl = async () => ({ content: [{ type: "text", text: "ok" }] });
  mockClientHooks.instances.length = 0;
  mockClientHooks.transports.length = 0;
  mockCatalog(REMOTE_ENTRY);
  (markNeedsReauth as jest.Mock).mockClear();
});

afterEach(async () => {
  await hubShutdown();
});

describe("hubBackoffMs", () => {
  it("grows exponentially from the base and caps", () => {
    expect(hubBackoffMs(0)).toBe(0);
    expect(hubBackoffMs(1)).toBe(HUB_BACKOFF_BASE_MS);
    expect(hubBackoffMs(2)).toBe(HUB_BACKOFF_BASE_MS * 2);
    expect(hubBackoffMs(3)).toBe(HUB_BACKOFF_BASE_MS * 4);
    expect(hubBackoffMs(50)).toBe(60_000);
  });
});

describe("connect / status machine", () => {
  it("connects once for concurrent callers (single flight) and reports connected", async () => {
    let connects = 0;
    mockClientHooks.connectImpl = async () => {
      connects += 1;
      await new Promise((r) => setTimeout(r, 20));
    };
    await Promise.all([hubListTools(USER, "acme-cloud"), hubListTools(USER, "acme-cloud"), hubCallTool(USER, "acme-cloud", "ping")]);
    expect(connects).toBe(1);
    expect(hubStatus(USER, "acme-cloud").status).toBe("connected");
    expect(mockClientHooks.instances).toHaveLength(1);
  });

  it("hands the transport the SSRF-guarded fetch (C7)", async () => {
    await hubListTools(USER, "acme-cloud");
    expect(mockClientHooks.transports[0].opts.fetch).toBe(ssrfFetch);
    expect(mockClientHooks.transports[0].url).toBe("https://mcp.acme.test/mcp");
  });

  it("maps UnauthorizedError to needs_reauth + markNeedsReauth, and never retries by itself", async () => {
    mockClientHooks.connectImpl = async () => {
      throw new UnauthorizedError("expired");
    };
    expect(await errCode(hubListTools(USER, "acme-cloud"))).toBe("needs_reauth");
    expect(markNeedsReauth).toHaveBeenCalledTimes(1);
    expect(hubStatus(USER, "acme-cloud").status).toBe("needs_reauth");
    // Second attempt must NOT reconnect — user action required.
    expect(await errCode(hubCallTool(USER, "acme-cloud", "ping"))).toBe("needs_reauth");
    expect(mockClientHooks.instances).toHaveLength(1);
  });

  it("counts connect failures and gates retries behind cooldown until the backoff elapses", async () => {
    let attempt = 0;
    mockClientHooks.connectImpl = async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError("fetch failed");
    };
    expect(await errCode(hubListTools(USER, "acme-cloud"))).toBe("connect_failed");
    const st = hubStatus(USER, "acme-cloud");
    expect(st.status).toBe("error");
    expect(st.failures).toBe(1);
    expect(st.retryAt).toBeGreaterThan(Date.now());
    // Inside the window: cooldown, no new connect attempt.
    expect(await errCode(hubCallTool(USER, "acme-cloud", "ping"))).toBe("cooldown");
    expect(attempt).toBe(1);
    // After the window: reconnects and resets failures.
    await new Promise((r) => setTimeout(r, HUB_BACKOFF_BASE_MS + 50));
    const out = await hubCallTool(USER, "acme-cloud", "ping");
    expect(out.text).toBe("ok");
    expect(hubStatus(USER, "acme-cloud").status).toBe("connected");
    expect(hubStatus(USER, "acme-cloud").failures).toBe(0);
    expect(attempt).toBe(2);
  });

  it("rejects servers with no remote endpoint and remote token auth", async () => {
    mockCatalog(null);
    expect(await errCode(hubCallTool(USER, "nope", "ping"))).toBe("no_remote");
    mockCatalog({ ...REMOTE_ENTRY, auth: "token", oauth: undefined });
    expect(await errCode(hubCallTool(USER, "acme-cloud", "ping"))).toBe("unsupported_auth");
    expect(hubStatus(USER, "acme-cloud").status).toBe("disconnected");
  });
});

describe("hubListTools", () => {
  it("caches tools/list for the TTL and refresh forces a re-fetch", async () => {
    let lists = 0;
    mockClientHooks.listToolsImpl = async () => {
      lists += 1;
      return { tools: [{ name: "t1", description: "d", inputSchema: {}, annotations: { readOnlyHint: true } }] };
    };
    const a = await hubListTools(USER, "acme-cloud");
    const b = await hubListTools(USER, "acme-cloud");
    expect(lists).toBe(1);
    expect(a).toBe(b);
    expect(a[0].annotations).toEqual({ readOnlyHint: true });
    await hubListTools(USER, "acme-cloud", { refresh: true });
    expect(lists).toBe(2);
  });

  it("defaults missing annotations away and caps the tool count at HUB_MAX_TOOLS", async () => {
    mockClientHooks.listToolsImpl = async () => ({
      tools: Array.from({ length: 250 }, (_, i) => ({ name: `t${i}`, description: "", inputSchema: { type: "object" } })),
    });
    const tools = await hubListTools(USER, "acme-cloud");
    expect(tools).toHaveLength(200);
    expect(tools[0].annotations).toBeUndefined();
  });
});

describe("hubCallTool", () => {
  it("normalizes content arrays and surfaces isError", async () => {
    mockClientHooks.callToolImpl = async () => ({ content: [{ type: "text", text: "line1" }, { type: "resource" }], isError: true });
    const out = await hubCallTool(USER, "acme-cloud", "do_thing", { a: 1 });
    expect(out).toEqual({ text: "line1\n[resource content omitted]", isError: true });
  });

  it("enforces the per-server concurrency cap with FIFO waiters", async () => {
    const gates: Array<() => void> = [];
    mockClientHooks.callToolImpl = () =>
      new Promise((resolve) => {
        gates.push(() => resolve({ content: [{ type: "text", text: "done" }] }));
      });
    const running = Array.from({ length: HUB_MAX_INFLIGHT }, () => hubCallTool(USER, "acme-cloud", "slow"));
    await new Promise((r) => setTimeout(r, 10));
    expect(gates).toHaveLength(HUB_MAX_INFLIGHT);
    const waiting = hubCallTool(USER, "acme-cloud", "slow");
    await new Promise((r) => setTimeout(r, 10));
    expect(gates).toHaveLength(HUB_MAX_INFLIGHT); // 5th is parked, not running
    gates[0]();
    await new Promise((r) => setTimeout(r, 10));
    expect(gates).toHaveLength(HUB_MAX_INFLIGHT + 1);
    gates.forEach((g, i) => i > 0 && g());
    const all = await Promise.all([...running, waiting]);
    expect(all).toHaveLength(HUB_MAX_INFLIGHT + 1);
    expect(hubStatus(USER, "acme-cloud").status).toBe("connected");
  });

  it("times out a hung call, drops the session, and backs off", async () => {
    mockClientHooks.callToolImpl = () => new Promise(() => {});
    expect(await errCode(hubCallTool(USER, "acme-cloud", "hang", {}, { timeoutMs: 40 }))).toBe("call_timeout");
    expect(hubStatus(USER, "acme-cloud").status).toBe("error");
    expect(hubStatus(USER, "acme-cloud").failures).toBe(1);
    expect(await errCode(hubCallTool(USER, "acme-cloud", "hang", {}, { timeoutMs: 40 }))).toBe("cooldown");
    expect(mockClientHooks.instances[0].closed).toBe(true);
  });

  it("keeps the session healthy on protocol errors (bad params / unknown tool)", async () => {
    mockClientHooks.callToolImpl = async () => {
      throw new Error("MCP error -32602: invalid params");
    };
    const msg = await hubCallTool(USER, "acme-cloud", "nope").then(
      () => "resolved",
      (e) => (e as Error).message
    );
    expect(msg).toMatch(/invalid params/);
    expect(hubStatus(USER, "acme-cloud").status).toBe("connected");
    expect(hubStatus(USER, "acme-cloud").failures).toBe(0);
    expect(mockClientHooks.instances[0].closed).toBe(false);
  });
});

describe("lifecycle", () => {
  it("hubCloseServer closes the client and resets the session", async () => {
    await hubCallTool(USER, "acme-cloud", "ping");
    expect(hubStatus(USER, "acme-cloud").status).toBe("connected");
    await hubCloseServer(USER, "acme-cloud");
    expect(hubStatus(USER, "acme-cloud").status).toBe("disconnected");
    expect(mockClientHooks.instances[0].closed).toBe(true);
    // Reconnects fresh afterwards.
    await hubCallTool(USER, "acme-cloud", "ping");
    expect(mockClientHooks.instances).toHaveLength(2);
  });

  it("closes idle sessions after HUB_IDLE_TTL_MS (fake timers)", async () => {
    jest.useFakeTimers();
    try {
      await hubCallTool(USER, "acme-cloud", "ping");
      expect(hubStatus(USER, "acme-cloud").status).toBe("connected");
      await jest.advanceTimersByTimeAsync(5 * 60_000 + 1000);
      expect(hubStatus(USER, "acme-cloud").status).toBe("disconnected");
      expect(mockClientHooks.instances[0].closed).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("RuntimeMcpOAuthProvider", () => {
  const providerOpts = {
    userId: USER,
    serverId: "acme-cloud",
    endpointUrl: "https://mcp.acme.test/mcp",
    transport: "streamable-http" as const,
    clientName: "Acme Cloud",
    staticClientId: "static_123",
  };

  it("serves stored client info and never DCRs at runtime", async () => {
    const { loadConnectionCredentials } = jest.requireMock("@/lib/mcp/oauth/store");
    const p = new RuntimeMcpOAuthProvider(providerOpts);
    loadConnectionCredentials.mockResolvedValueOnce({ client_id: "stored_1" });
    await expect(p.clientInformation()).resolves.toEqual({ client_id: "stored_1" });
    loadConnectionCredentials.mockResolvedValue(undefined);
    await expect(p.clientInformation()).resolves.toEqual({ client_id: "static_123" });
    const noStatic = new RuntimeMcpOAuthProvider({ ...providerOpts, staticClientId: undefined });
    await expect(noStatic.clientInformation()).rejects.toMatchObject({ code: "mcp_interactive_auth_required" });
  });

  it("throws typed interactive-required on browser legs", async () => {
    const p = new RuntimeMcpOAuthProvider(providerOpts);
    expect(() => p.state()).toThrow(/connect it through POST/i);
    await expect(p.redirectToAuthorization()).rejects.toMatchObject({ code: "mcp_interactive_auth_required" });
    await expect(p.codeVerifier()).rejects.toMatchObject({ code: "mcp_interactive_auth_required" });
  });

  it("persists refreshed tokens through saveTokens", async () => {
    const { saveConnectionTokens } = jest.requireMock("@/lib/mcp/oauth/store");
    const p = new RuntimeMcpOAuthProvider(providerOpts);
    await p.saveTokens({ access_token: "a", token_type: "Bearer" });
    expect(saveConnectionTokens).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, serverId: "acme-cloud", tokens: { access_token: "a", token_type: "Bearer" } })
    );
  });
});
