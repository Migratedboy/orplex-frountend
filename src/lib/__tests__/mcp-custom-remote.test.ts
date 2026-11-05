// Unit tests for user-added remote MCP servers (custom-remote.ts): id
// derivation/policy, upsert (Prisma row, status disconnected), resolution to
// a synthetic catalog entry, and removal (row + tool snapshot). Prisma is
// mocked; the SSRF policy runs for real — a private-IP URL must be refused.

jest.mock("@/lib/prisma", () => ({
  prisma: {
    mcpConnection: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
    },
    mcpTool: {
      deleteMany: jest.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import {
  customRemoteIdFor,
  deleteCustomRemote,
  isCustomRemoteId,
  loadCustomRemote,
  makeCustomRemoteEntry,
  upsertCustomRemote,
} from "@/lib/mcp/custom-remote";

const conn = prisma.mcpConnection as unknown as {
  upsert: jest.Mock;
  findUnique: jest.Mock;
  delete: jest.Mock;
};
const tools = prisma.mcpTool as unknown as { deleteMany: jest.Mock };

const URL_A = "https://mcp.example.dev/mcp";

beforeEach(() => {
  jest.clearAllMocks();
  conn.upsert.mockResolvedValue({} as never);
  conn.findUnique.mockResolvedValue(null as never);
  conn.delete.mockResolvedValue({} as never);
  tools.deleteMany.mockResolvedValue({ count: 0 } as never);
});

describe("id policy", () => {
  it("derives a stable remote-<hash> id from the URL", () => {
    const id = customRemoteIdFor(URL_A);
    expect(id).toMatch(/^remote-[0-9a-f]{12}$/);
    expect(customRemoteIdFor(URL_A)).toBe(id);
    expect(customRemoteIdFor(URL_A + "/")).not.toBe(id); // url-exact
  });

  it("classifies ids", () => {
    expect(isCustomRemoteId(customRemoteIdFor(URL_A))).toBe(true);
    expect(isCustomRemoteId("supabase")).toBe(false);
    expect(isCustomRemoteId("")).toBe(false);
  });
});

describe("upsertCustomRemote", () => {
  it("creates a disconnected row with no tokens and returns the synthetic entry", async () => {
    const { serverId, entry } = await upsertCustomRemote("u1", { url: URL_A });
    expect(serverId).toBe(customRemoteIdFor(URL_A));
    expect(conn.upsert).toHaveBeenCalledWith({
      where: { userId_serverId: { userId: "u1", serverId } },
      create: expect.objectContaining({
        userId: "u1",
        serverId,
        url: URL_A,
        transport: "streamable-http",
        status: "disconnected",
      }),
      update: expect.objectContaining({ url: URL_A, transport: "streamable-http" }),
    });
    expect(entry.remote).toEqual({ url: URL_A, transport: "streamable-http" });
    expect(entry.auth).toBe("oauth");
    expect(entry.name).toBe("mcp.example.dev");
  });

  it("refuses URLs that fail the SSRF policy", async () => {
    await expect(upsertCustomRemote("u1", { url: "http://192.168.1.50/mcp" })).rejects.toThrow(/SSRF/);
    expect(conn.upsert).not.toHaveBeenCalled();
  });

  it("keeps sse when requested", async () => {
    await upsertCustomRemote("u1", { url: URL_A, transport: "sse" });
    expect(conn.upsert.mock.calls[0][0].create.transport).toBe("sse");
  });
});

describe("loadCustomRemote", () => {
  it("round-trips through the row", async () => {
    const id = customRemoteIdFor(URL_A);
    conn.findUnique.mockResolvedValue({ serverId: id, url: URL_A, transport: "streamable-http" } as never);
    const entry = await loadCustomRemote("u1", id);
    expect(entry).toMatchObject({ id, auth: "oauth", remote: { url: URL_A } });
  });

  it("answers null for catalog ids and unknown rows", async () => {
    expect(await loadCustomRemote("u1", "supabase")).toBeNull();
    conn.findUnique.mockResolvedValue(null as never);
    expect(await loadCustomRemote("u1", customRemoteIdFor(URL_A))).toBeNull();
  });
});

describe("deleteCustomRemote", () => {
  it("removes the row and the tool snapshot", async () => {
    const id = customRemoteIdFor(URL_A);
    conn.findUnique.mockResolvedValue({ id: "row_1" } as never);
    expect(await deleteCustomRemote("u1", id)).toBe(true);
    expect(conn.delete).toHaveBeenCalledWith({ where: { id: "row_1" } });
    expect(tools.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1", serverId: id } });
  });

  it("refuses catalog ids and nonexistent rows", async () => {
    expect(await deleteCustomRemote("u1", "supabase")).toBe(false);
    conn.findUnique.mockResolvedValue(null as never);
    expect(await deleteCustomRemote("u1", customRemoteIdFor(URL_A))).toBe(false);
    expect(conn.delete).not.toHaveBeenCalled();
  });
});

describe("makeCustomRemoteEntry", () => {
  it("builds a valid oauth-shaped entry even for a malformed url", () => {
    const e = makeCustomRemoteEntry("remote-1", "not a url", "streamable-http");
    expect(e.auth).toBe("oauth");
    expect(e.name).toBe("not a url");
  });
});
