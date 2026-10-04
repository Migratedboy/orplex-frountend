// proxy-mcp-local.test.ts — conflict C2: ALL MCP routes must stay on THIS
// process (prefix match), because the OAuth token store, one-time pending
// states, and Prisma connection rows live here. The backend must never see
// them (split-brain) and non-MCP /api/agent/* must keep rewriting.

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
])("keeps %s local (no backend rewrite)", async (path) => {
  const res = await handler(req(path));
  expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  expect(res.status).toBe(200);
});

it.each(["/api/agent/runs/r1", "/api/agent/mcp-tools-backup", "/api/mcpx"])(
  "still rewrites non-MCP route %s to the backend",
  async (path) => {
    const res = await handler(req(path));
    expect(res.headers.get("x-middleware-rewrite")).toContain(`http://localhost:5010${path.split("?")[0]}`);
  }
);
