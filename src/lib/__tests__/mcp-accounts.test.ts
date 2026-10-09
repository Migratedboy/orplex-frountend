// Unit tests for mcp-accounts: secret encryption at rest, blank-secret
// preservation on update, caps, and the executor's config collection with
// deterministic slot ranking.
import { prisma } from "@/lib/prisma";
import { resetMcpSessionsForTests } from "@/lib/mcp-client";
import {
  listConnectedServers,
  connectServer,
  disconnectServer,
  setServerEnabled,
  collectMcpServerConfigs,
  getServerRunConfig,
  MAX_MCP_SERVERS_PER_RUN,
} from "@/lib/mcp-accounts";
import { encryptKey, decryptKey } from "@/lib/key-encryption";

jest.mock("@/lib/prisma", () => ({
  prisma: {
    mcpServerConfig: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

const mocked = prisma.mcpServerConfig as jest.Mocked<typeof prisma.mcpServerConfig>;

const USER = "user_test_1";

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "row1",
    userId: USER,
    serverId: "supabase",
    label: null,
    command: "npx",
    args: ["-y", "@supabase/mcp-server-supabase"],
    env: { SUPABASE_ACCESS_TOKEN: encryptKey("sb_secret_token") },
    enabled: true,
    lastTestAt: null,
    lastTestOk: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetMcpSessionsForTests();
});

describe("connectServer", () => {
  it("encrypts secret env values at rest", async () => {
    mocked.count.mockResolvedValue(0);
    mocked.findUnique.mockResolvedValue(null);
    (mocked.upsert as jest.Mock).mockImplementation(async ({ create }) => create);

    const res = await connectServer(USER, "supabase", { env: { SUPABASE_ACCESS_TOKEN: "plain-token" } });
    expect(res.ok).toBe(true);

    const stored = (mocked.upsert.mock.calls[0][0] as { create: { env: Record<string, string> } }).create.env;
    expect(stored.SUPABASE_ACCESS_TOKEN).not.toBe("plain-token");
    expect(stored.SUPABASE_ACCESS_TOKEN.split(":").length).toBe(3); // iv:tag:ciphertext
    expect(decryptKey(stored.SUPABASE_ACCESS_TOKEN)).toBe("plain-token");
  });

  it("rejects unknown catalog ids", async () => {
    const res = await connectServer(USER, "not-a-server", {});
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });

  it("enforces the per-user connector cap on NEW connections", async () => {
    mocked.count.mockResolvedValue(20);
    mocked.findUnique.mockResolvedValue(null);
    const res = await connectServer(USER, "github", {});
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error).toContain("limit");
  });

  it("preserves stored secrets when the update leaves them blank", async () => {
    const cipher = encryptKey("existing-secret");
    mocked.count.mockResolvedValue(1);
    mocked.findUnique.mockResolvedValue(row({ env: { SUPABASE_ACCESS_TOKEN: cipher } }) as never);
    (mocked.upsert as jest.Mock).mockImplementation(async ({ update }) => update);

    await connectServer(USER, "supabase", { env: {} }); // blank secret
    const update = (mocked.upsert.mock.calls[0][0] as { update: { env: Record<string, string> } }).update;
    expect(update.env.SUPABASE_ACCESS_TOKEN).toBe(cipher); // untouched
  });

  it("re-encrypts when a new secret is supplied", async () => {
    const cipher = encryptKey("existing-secret");
    mocked.count.mockResolvedValue(1);
    mocked.findUnique.mockResolvedValue(row({ env: { SUPABASE_ACCESS_TOKEN: cipher } }) as never);
    (mocked.upsert as jest.Mock).mockImplementation(async ({ update }) => update);

    await connectServer(USER, "supabase", { env: { SUPABASE_ACCESS_TOKEN: "brand-new" } });
    const update = (mocked.upsert.mock.calls[0][0] as { update: { env: Record<string, string> } }).update;
    expect(decryptKey(update.env.SUPABASE_ACCESS_TOKEN)).toBe("brand-new");
  });
});

describe("listConnectedServers (masking)", () => {
  it("masks secrets and reports which keys hold them", async () => {
    mocked.findMany.mockResolvedValue([row()] as never);
    const servers = await listConnectedServers(USER);
    expect(servers).toHaveLength(1);
    const s = servers[0];
    expect(s.secretsSet).toContain("SUPABASE_ACCESS_TOKEN");
    expect(s.env.SUPABASE_ACCESS_TOKEN).toContain("...");
    expect(s.env.SUPABASE_ACCESS_TOKEN).not.toContain("sb_secret_token");
  });

  it("passes plain (non-secret) env values through unmasked", async () => {
    mocked.findMany.mockResolvedValue([
      row({ serverId: "shell", env: { SHELL_ALLOWLIST: "ls,grep,wc" } }) as never,
    ]);
    const servers = await listConnectedServers(USER);
    expect(servers[0].env.SHELL_ALLOWLIST).toBe("ls,grep,wc");
  });

  it("masks connection strings too (they are marked secret in the catalog)", async () => {
    mocked.findMany.mockResolvedValue([
      row({ serverId: "postgres", env: { DATABASE_URI: encryptKey("postgres://u:p@h/db") } }) as never,
    ]);
    const servers = await listConnectedServers(USER);
    expect(servers[0].secretsSet).toContain("DATABASE_URI");
    expect(servers[0].env.DATABASE_URI).not.toContain("postgres://");
  });
});

describe("collectMcpServerConfigs (executor)", () => {
  it("returns empty config for users with nothing connected", async () => {
    mocked.findMany.mockResolvedValue([] as never);
    expect(await collectMcpServerConfigs(USER)).toEqual({});
  });

  it("decrypts secrets into spawn-ready config", async () => {
    mocked.findMany.mockResolvedValue([row()] as never);
    const cfg = await collectMcpServerConfigs(USER);
    expect(cfg.supabase).toBeDefined();
    expect(cfg.supabase.command).toBe("npx");
    expect(cfg.supabase.env?.SUPABASE_ACCESS_TOKEN).toBe("sb_secret_token");
  });

  it("skips undecryptable secrets instead of crashing", async () => {
    mocked.findMany.mockResolvedValue([row({ env: { SUPABASE_ACCESS_TOKEN: "garbage" } })] as never);
    const cfg = await collectMcpServerConfigs(USER);
    expect(cfg.supabase.env?.SUPABASE_ACCESS_TOKEN).toBe("");
  });

  it("caps the run at MAX_MCP_SERVERS_PER_RUN and ranks tested-OK first", async () => {
    const rows = [
      row({ id: "r1", serverId: "s3", env: { AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: encryptKey("s") }, lastTestOk: false }),
      row({ id: "r2", serverId: "github", env: { GITHUB_PERSONAL_ACCESS_TOKEN: encryptKey("g") }, lastTestOk: true }),
      row({ id: "r3", serverId: "supabase", env: { SUPABASE_ACCESS_TOKEN: encryptKey("s") }, lastTestOk: true }),
      row({ id: "r4", serverId: "memory", env: {} }),
    ];
    mocked.findMany.mockResolvedValue(rows as never);
    const cfg = await collectMcpServerConfigs(USER);
    const keys = Object.keys(cfg);
    expect(keys.length).toBe(MAX_MCP_SERVERS_PER_RUN);
    // Both tested-OK servers win the slots; the failing one is out.
    expect(keys).toContain("github");
    expect(keys).toContain("supabase");
    expect(keys).not.toContain("s3");
  });
});

describe("lifecycle helpers", () => {
  it("setServerEnabled / disconnectServer report what happened", async () => {
    mocked.updateMany.mockResolvedValue({ count: 1 } as never);
    expect(await setServerEnabled(USER, "github", false)).toBe(true);
    mocked.updateMany.mockResolvedValue({ count: 0 } as never);
    expect(await setServerEnabled(USER, "github", false)).toBe(false);

    mocked.deleteMany.mockResolvedValue({ count: 1 } as never);
    expect(await disconnectServer(USER, "github")).toBe(true);
  });

  it("getServerRunConfig returns null for unconnected servers", async () => {
    mocked.findUnique.mockResolvedValue(null);
    expect(await getServerRunConfig(USER, "figma")).toBeNull();
  });
});
