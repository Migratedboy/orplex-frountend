// Unit tests for the Connectors-panel read model (spec Phase 7): joins
// SafeConnection rows (store.ts) with catalog metadata and Phase 5 tool
// snapshot counts. Prisma is mocked; the catalog is the real one.

import { prisma } from "@/lib/prisma";

jest.mock("@/lib/prisma", () => ({
  prisma: {
    mcpConnection: {
      findMany: jest.fn(),
    },
    mcpTool: {
      groupBy: jest.fn(),
    },
  },
}));

import { listConnectionViews } from "@/lib/mcp/connection-view";
import { getMcpCatalogEntry } from "@/lib/mcp-catalog";

const conn = prisma.mcpConnection as jest.Mocked<typeof prisma.mcpConnection>;
const tools = prisma.mcpTool as jest.Mocked<typeof prisma.mcpTool>;

const USER = "user_view_1";

function row(overrides: Record<string, unknown> = {}) {
  return {
    serverId: "github",
    url: "https://api.githubcopilot.com/mcp/",
    transport: "streamable-http",
    status: "connected",
    issuer: null,
    scope: "repo",
    expiresAt: null,
    lastTestAt: null,
    lastTestOk: true,
    autoApproveReadOnly: true,
    failureReason: null,
    updatedAt: new Date("2026-10-05T00:00:00.000Z"),
    ...overrides,
  };
}

describe("listConnectionViews", () => {
  it("merges catalog metadata + tool-snapshot counts into each row", async () => {
    conn.findMany.mockResolvedValue([row()] as never);
    tools.groupBy.mockResolvedValue([{ serverId: "github", _count: { _all: 12 } }] as never);

    const views = await listConnectionViews(USER);

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      serverId: "github",
      name: getMcpCatalogEntry("github")!.name,
      auth: getMcpCatalogEntry("github")!.auth,
      toolCount: 12,
      autoApproveReadOnly: true,
      status: "connected",
    });
    expect(tools.groupBy).toHaveBeenCalledWith({
      by: ["serverId"],
      where: { userId: USER },
      _count: { _all: true },
    });
  });

  it("falls back to serverId/url for unknown ids and 0 tools without a snapshot", async () => {
    conn.findMany.mockResolvedValue([row({ serverId: "my-custom-server", url: "https://x.test/mcp" })] as never);
    tools.groupBy.mockResolvedValue([] as never);

    const views = await listConnectionViews(USER);

    expect(views[0]).toMatchObject({
      name: "my-custom-server",
      description: "https://x.test/mcp",
      auth: "none",
      toolCount: 0,
    });
  });

  it("returns an empty list when nothing is connected", async () => {
    conn.findMany.mockResolvedValue([] as never);
    tools.groupBy.mockResolvedValue([] as never);
    await expect(listConnectionViews(USER)).resolves.toEqual([]);
  });
});
