// proxy-mcp-local.test.ts — the MCP split contract, UPDATED for the cloud
// Postgres: ALL MCP routes (prefix match) now REWRITE to the backend, which
// owns the same handlers verbatim and keeps tokens, one-time pending states,
// and connection rows in ONE place (the old local Postgres is gone). The
// desktop stdio bridge keeps its runtime callbacks out of band
// (electron/mcp-bridge.ts) — the proxy does not see those connections.

export {};

let handler: (req: unknown) => Promise<Response>;
const getToken = jest.fn();

jest.mock("next-auth/jwt", () => ({
  getToken: (...args: unknown[]) => getToken(...args),
}));

function req(path: string, origin = "http://localhost:5000") {
  const url = new URL(`${origin}${path}`);
  return {
    method: "GET",
    url: url.toString(),
    nextUrl: url,
    headers: new Headers(),
  } as unknown as Parameters<typeof handler>[0];
}

function loadProxy() {
  jest.isolateModules(() => {
    const mod = require("@/proxy") as { default: typeof handler };
    handler = mod.default;
  });
}

beforeAll(() => {
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://localhost:5010";
});

afterAll(() => {
  delete process.env.NEXT_PUBLIC_API_BASE_URL;
});

beforeEach(() => {
  jest.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  getToken.mockReset().mockResolvedValue({ id: "u1" });
  loadProxy();
});

afterEach(() => {
  jest.restoreAllMocks();
});

it.each([
  "/api/mcp/catalog?q=figma",
  "/api/mcp/oauth/complete",
  "/api/mcp/oauth/callback?state=abc&code=xyz",
  "/api/mcp/connections/supabase/connect",
  "/api/mcp/connections/supabase/disconnect",
  "/api/agent/mcp/tools?runId=r1",
])("rewrites %s to the backend (cloud MCP)", async (path) => {
  const res = await handler(req(path));
  expect(res.headers.get("x-middleware-rewrite")).toContain(`http://localhost:5010${path.split("?")[0]}`);
});

it.each(["/api/agent/runs/r1", "/api/agent/mcp-tools-backup", "/api/mcpx"])(
  "still rewrites non-MCP route %s to the backend",
  async (path) => {
    const res = await handler(req(path));
    expect(res.headers.get("x-middleware-rewrite")).toContain(`http://localhost:5010${path.split("?")[0]}`);
  }
);

it.each(["/api/system/memory", "/api/agent/workspace-cwd", "/api/conversations"])(
  "keeps the genuinely local route %s un-rewritten",
  async (path) => {
    const res = await handler(req(path));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  }
);
