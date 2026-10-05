// mcp-risk-db.test.ts — server-lane C6 lookup: snapshot annotations + the
// Prisma autoApproveReadOnly toggle, failing closed on any read error.
jest.mock("../mcp/tool-snapshot", () => ({
  getToolSnapshot: jest.fn(),
  loadMcpServerPrefsDb: jest.fn(),
}));

import { assessMcpToolRiskDb } from "../mcp/risk-db";
import { getToolSnapshot, loadMcpServerPrefsDb } from "../mcp/tool-snapshot";

const getToolSnapshotMock = getToolSnapshot as jest.Mock;
const loadPrefsMock = loadMcpServerPrefsDb as jest.Mock;

describe("assessMcpToolRiskDb", () => {
  beforeEach(() => jest.clearAllMocks());

  it("auto-approves only with read-only annotation AND the per-server toggle", async () => {
    getToolSnapshotMock.mockResolvedValue([{ name: "list_items", annotations: { readOnlyHint: true } }]);
    loadPrefsMock.mockResolvedValue({ autoApproveReadOnly: true });
    expect(await assessMcpToolRiskDb("u1", "mcp__acme__list_items")).toMatchObject({
      level: "low",
      autoApprovable: true,
    });
  });

  it("stays medium without the toggle (C6: annotation alone is not enough)", async () => {
    getToolSnapshotMock.mockResolvedValue([{ name: "list_items", annotations: { readOnlyHint: true } }]);
    loadPrefsMock.mockResolvedValue({ autoApproveReadOnly: false });
    expect(await assessMcpToolRiskDb("u1", "mcp__acme__list_items")).toMatchObject({
      level: "medium",
      autoApprovable: false,
    });
  });

  it("never auto-approves unknown tools (missing from the snapshot)", async () => {
    getToolSnapshotMock.mockResolvedValue([]);
    loadPrefsMock.mockResolvedValue({ autoApproveReadOnly: true });
    expect(await assessMcpToolRiskDb("u1", "mcp__acme__create_issue")).toMatchObject({
      level: "medium",
      autoApprovable: false,
    });
  });

  it("flags server-declared destructive tools high, even with the toggle", async () => {
    getToolSnapshotMock.mockResolvedValue([
      { name: "wipe", annotations: { readOnlyHint: true, destructiveHint: true } },
    ]);
    loadPrefsMock.mockResolvedValue({ autoApproveReadOnly: true });
    expect(await assessMcpToolRiskDb("u1", "mcp__acme__wipe")).toMatchObject({
      level: "high",
      autoApprovable: false,
    });
  });

  it("fails closed when the snapshot or prefs read throws", async () => {
    getToolSnapshotMock.mockRejectedValue(new Error("db down"));
    loadPrefsMock.mockResolvedValue({ autoApproveReadOnly: true });
    expect(await assessMcpToolRiskDb("u1", "mcp__acme__list_items")).toMatchObject({
      level: "medium",
      autoApprovable: false,
    });

    getToolSnapshotMock.mockResolvedValue([{ name: "list_items", annotations: { readOnlyHint: true } }]);
    loadPrefsMock.mockRejectedValue(new Error("db down"));
    expect(await assessMcpToolRiskDb("u1", "mcp__acme__list_items")).toMatchObject({
      level: "medium",
      autoApprovable: false,
    });
  });

  it("falls back to plain classifyRisk for non-MCP names", async () => {
    const r = await assessMcpToolRiskDb("u1", "read_file");
    expect(r.level).toBe("low");
    expect(r.autoApprovable).toBe(true);
    expect(getToolSnapshotMock).not.toHaveBeenCalled();
    expect(loadPrefsMock).not.toHaveBeenCalled();
  });
});
