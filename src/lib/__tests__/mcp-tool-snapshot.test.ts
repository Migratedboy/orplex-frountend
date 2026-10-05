// mcp-tool-snapshot.test.ts — Phase 5 discovery persistence: pure diff,
// sync writes (upsert/delete/status flip), snapshot reads, prefs lookup.

jest.mock("@/lib/prisma", () => ({
  prisma: {
    mcpTool: {
      findMany: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    mcpConnection: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
  },
}));

import { prisma } from "@/lib/prisma";
import {
  SNAPSHOT_MAX_TOOLS,
  clearToolSnapshot,
  diffTools,
  getToolSnapshot,
  listSnapshotToolsByServer,
  loadMcpServerPrefsDb,
  syncToolSnapshot,
} from "@/lib/mcp/tool-snapshot";

const mocked = prisma as unknown as {
  mcpTool: { findMany: jest.Mock; upsert: jest.Mock; deleteMany: jest.Mock };
  mcpConnection: { findUnique: jest.Mock; update: jest.Mock };
  $transaction: jest.Mock;
};

const U = "user_1";

beforeEach(() => {
  jest.clearAllMocks();
  mocked.mcpTool.findMany.mockResolvedValue([]);
  mocked.mcpTool.upsert.mockResolvedValue({});
  mocked.mcpTool.deleteMany.mockResolvedValue({ count: 0 });
  mocked.mcpConnection.findUnique.mockResolvedValue(null);
  mocked.mcpConnection.update.mockResolvedValue({});
  mocked.$transaction.mockImplementation(async (ops: Array<Promise<unknown>>) => Promise.all(ops));
});

describe("diffTools (pure)", () => {
  const a = { name: "a", description: "A", inputSchema: { type: "object" } };

  it("classifies added / removed / changed / unchanged", () => {
    const prev = [a, { name: "b", description: "B", inputSchema: {} }];
    const next = [
      a,
      { name: "b", description: "B edited", inputSchema: {} },
      { name: "c", description: "C", inputSchema: {} },
    ];
    const diff = diffTools(prev, next);
    expect(diff.added).toEqual(["c"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual(["b"]);
    expect(diff.unchanged).toBe(1);
    expect(diff.status).toBe("connected");
  });

  it("an empty next list removes everything and reports connected_no_tools", () => {
    const diff = diffTools([a], []);
    expect(diff.removed).toEqual(["a"]);
    expect(diff.status).toBe("connected_no_tools");
  });

  it("classifies a name only present in prev as removed", () => {
    const diff = diffTools([a, { name: "gone", description: "", inputSchema: {} }], [a]);
    expect(diff.removed).toEqual(["gone"]);
    expect(diff.unchanged).toBe(1);
  });

  it("treats a schema change as a change even with the same description", () => {
    const diff = diffTools(
      [{ name: "a", description: "A", inputSchema: { type: "object", properties: { x: 1 } } }],
      [{ name: "a", description: "A", inputSchema: { type: "object", properties: { y: 1 } } }]
    );
    expect(diff.changed).toEqual(["a"]);
    expect(diff.unchanged).toBe(0);
  });
});

describe("syncToolSnapshot", () => {
  it("upserts everything, deletes missing rows, and returns the diff", async () => {
    mocked.mcpTool.findMany.mockResolvedValue([
      { name: "keep", description: "same", inputSchema: { type: "object" }, annotations: null },
      { name: "gone", description: "x", inputSchema: null, annotations: null },
    ]);
    mocked.mcpConnection.findUnique.mockResolvedValue({ status: "connected" });

    const diff = await syncToolSnapshot(U, "github", [
      { name: "keep", description: "same", inputSchema: { type: "object" } },
      { name: "new", description: "fresh", inputSchema: { type: "object" } },
    ]);

    expect(diff.added).toEqual(["new"]);
    expect(diff.removed).toEqual(["gone"]);
    expect(diff.changed).toEqual([]);
    expect(diff.status).toBe("connected");

    expect(mocked.mcpTool.deleteMany).toHaveBeenCalledWith({
      where: { userId: U, serverId: "github", name: { in: ["gone"] } },
    });
    expect(mocked.mcpTool.upsert).toHaveBeenCalledTimes(2);
    expect(mocked.mcpTool.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_serverId_name: { userId: U, serverId: "github", name: "keep" } },
        update: expect.objectContaining({ lastSeenAt: expect.any(Date) }),
        create: expect.objectContaining({ userId: U, serverId: "github", name: "keep" }),
      })
    );
    expect(mocked.$transaction).toHaveBeenCalled();
    // status already "connected" matching diff.status → no write
    expect(mocked.mcpConnection.update).not.toHaveBeenCalled();
  });

  it("flips a connected row to connected_no_tools when the list comes back empty", async () => {
    mocked.mcpTool.findMany.mockResolvedValue([{ name: "a", description: "", inputSchema: {}, annotations: null }]);
    mocked.mcpConnection.findUnique.mockResolvedValue({ status: "connected" });

    const diff = await syncToolSnapshot(U, "github", []);
    expect(diff.status).toBe("connected_no_tools");
    expect(mocked.mcpConnection.update).toHaveBeenCalledWith({
      where: { userId_serverId: { userId: U, serverId: "github" } },
      data: { status: "connected_no_tools" },
    });
  });

  it("NEVER clobbers needs_reauth / disconnected (OAuth state machine owns them)", async () => {
    mocked.mcpTool.findMany.mockResolvedValue([]);
    mocked.mcpConnection.findUnique.mockResolvedValue({ status: "needs_reauth" });

    const diff = await syncToolSnapshot(U, "github", [{ name: "a", description: "", inputSchema: {} }]);
    expect(diff.status).toBe("connected");
    expect(mocked.mcpConnection.update).not.toHaveBeenCalled();
  });

  it("caps the snapshot at SNAPSHOT_MAX_TOOLS rows", async () => {
    mocked.mcpConnection.findUnique.mockResolvedValue(null);
    const tools = Array.from({ length: SNAPSHOT_MAX_TOOLS + 25 }, (_, i) => ({
      name: `t${i}`,
      description: "",
      inputSchema: {},
    }));
    await syncToolSnapshot(U, "github", tools);
    expect(mocked.mcpTool.upsert).toHaveBeenCalledTimes(SNAPSHOT_MAX_TOOLS);
  });

  it("works with no connection row (snapshot before status exists)", async () => {
    mocked.mcpConnection.findUnique.mockResolvedValue(null);
    const diff = await syncToolSnapshot(U, "github", [{ name: "a", description: "", inputSchema: {} }]);
    expect(diff.status).toBe("connected");
    expect(mocked.mcpConnection.update).not.toHaveBeenCalled();
    expect(mocked.mcpTool.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("reads and prefs", () => {
  it("getToolSnapshot maps rows (orderBy rides on the DB call) and defaults null schema", async () => {
    mocked.mcpTool.findMany.mockResolvedValue([
      { name: "a", description: "A", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "b", description: "", inputSchema: null, annotations: null },
    ]);
    const snap = await getToolSnapshot(U, "github");
    expect(mocked.mcpTool.findMany).toHaveBeenCalledWith({
      where: { userId: U, serverId: "github" },
      orderBy: { name: "asc" },
    });
    expect(snap[0]).toEqual({
      name: "a",
      description: "A",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    });
    expect(snap[1].inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("listSnapshotToolsByServer flattens rows into BuilderTool shape", async () => {
    mocked.mcpTool.findMany.mockResolvedValue([
      { name: "a", description: "A", inputSchema: { type: "object" }, annotations: null, serverId: "github" },
    ]);
    const tools = await listSnapshotToolsByServer(U);
    expect(tools).toEqual([
      { server: "github", name: "a", description: "A", inputSchema: { type: "object" } },
    ]);
  });

  it("clearToolSnapshot deletes by pair and returns the count", async () => {
    mocked.mcpTool.deleteMany.mockResolvedValue({ count: 3 });
    await expect(clearToolSnapshot(U, "github")).resolves.toBe(3);
    expect(mocked.mcpTool.deleteMany).toHaveBeenCalledWith({
      where: { userId: U, serverId: "github" },
    });
  });

  it("loadMcpServerPrefsDb reads the Prisma-backed C6 toggle (default false)", async () => {
    mocked.mcpConnection.findUnique.mockResolvedValue(null);
    await expect(loadMcpServerPrefsDb(U, "github")).resolves.toEqual({ autoApproveReadOnly: false });

    mocked.mcpConnection.findUnique.mockResolvedValue({ autoApproveReadOnly: true });
    await expect(loadMcpServerPrefsDb(U, "github")).resolves.toEqual({ autoApproveReadOnly: true });
    expect(mocked.mcpConnection.findUnique).toHaveBeenCalledWith({
      where: { userId_serverId: { userId: U, serverId: "github" } },
      select: { autoApproveReadOnly: true },
    });
  });
});
