// roster-refresh.test.ts — Phase 9 discovery triggers: refresh a server
// right after sign-in, and self-heal connected servers missing from the
// snapshot on roster fetch (failures swallowed, never route-failing).
jest.mock("../mcp/oauth/store", () => ({ listConnections: jest.fn() }));
jest.mock("../mcp/hub", () => ({ hubListTools: jest.fn() }));
jest.mock("../mcp/tool-snapshot", () => ({
  listSnapshotToolsByServer: jest.fn(),
  syncToolSnapshot: jest.fn(),
}));

import { refreshServerSnapshot, refreshMissingSnapshots } from "../mcp/roster-refresh";
import { listConnections } from "../mcp/oauth/store";
import { hubListTools } from "../mcp/hub";
import { listSnapshotToolsByServer, syncToolSnapshot } from "../mcp/tool-snapshot";

const listConnectionsMock = listConnections as jest.Mock;
const hubListToolsMock = hubListTools as jest.Mock;
const listSnapshotMock = listSnapshotToolsByServer as jest.Mock;
const syncMock = syncToolSnapshot as jest.Mock;

describe("refreshServerSnapshot", () => {
  beforeEach(() => jest.clearAllMocks());

  it("lists tools through the hub and persists them as the snapshot", async () => {
    const tools = [{ name: "list_items", description: "", inputSchema: { type: "object" } }];
    hubListToolsMock.mockResolvedValue(tools);
    syncMock.mockResolvedValue({ added: 1 });

    await refreshServerSnapshot("u1", "acme-cloud");

    expect(hubListToolsMock).toHaveBeenCalledWith("u1", "acme-cloud");
    expect(syncMock).toHaveBeenCalledWith("u1", "acme-cloud", tools);
  });

  it("propagates failures to the caller (callers fire-and-forget with .catch)", async () => {
    hubListToolsMock.mockRejectedValue(new Error("401"));
    await expect(refreshServerSnapshot("u1", "acme-cloud")).rejects.toThrow("401");
    expect(syncMock).not.toHaveBeenCalled();
  });
});

describe("refreshMissingSnapshots", () => {
  beforeEach(() => jest.clearAllMocks());

  it("discovers connected servers that have no snapshot rows", async () => {
    listSnapshotMock.mockResolvedValue([]);
    listConnectionsMock.mockResolvedValue([
      { serverId: "acme-cloud", status: "connected" },
      { serverId: "supabase", status: "connected" },
    ]);
    hubListToolsMock.mockResolvedValue([{ name: "t" }]);
    syncMock.mockResolvedValue({ added: 1 });

    await refreshMissingSnapshots("u1");

    expect(hubListToolsMock).toHaveBeenCalledTimes(2);
    expect(hubListToolsMock).toHaveBeenCalledWith("u1", "acme-cloud");
    expect(hubListToolsMock).toHaveBeenCalledWith("u1", "supabase");
  });

  it("skips servers already in the snapshot and non-connected rows", async () => {
    listSnapshotMock.mockResolvedValue([{ server: "acme-cloud", name: "t" }]);
    listConnectionsMock.mockResolvedValue([
      { serverId: "acme-cloud", status: "connected" },
      { serverId: "stale", status: "needs_reauth" },
      { serverId: "off", status: "disconnected" },
    ]);

    await refreshMissingSnapshots("u1");

    expect(hubListToolsMock).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("swallows per-server errors so one dead server never fails the route", async () => {
    listSnapshotMock.mockResolvedValue([]);
    listConnectionsMock.mockResolvedValue([
      { serverId: "dead", status: "connected" },
      { serverId: "alive", status: "connected_no_tools" },
    ]);
    hubListToolsMock.mockImplementation((_u: string, serverId: string) =>
      serverId === "dead" ? Promise.reject(new Error("connect_failed")) : Promise.resolve([])
    );
    syncMock.mockResolvedValue({ added: 0 });

    await expect(refreshMissingSnapshots("u1")).resolves.toBeUndefined();
    expect(syncMock).toHaveBeenCalledWith("u1", "alive", []);
  });

  it("no-ops when the connection list itself fails", async () => {
    listSnapshotMock.mockResolvedValue([]);
    listConnectionsMock.mockRejectedValue(new Error("db down"));

    await expect(refreshMissingSnapshots("u1")).resolves.toBeUndefined();
    expect(hubListToolsMock).not.toHaveBeenCalled();
  });
});
