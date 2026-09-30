// proxy-frontend.test.ts — The FRONTEND proxy (src/proxy.ts) in the physical
// split: page routes redirect to signin without a session, authenticated pages
// pass through, and /api/auth + /api/dev are transparently rewritten to the
// backend origin when NEXT_PUBLIC_API_BASE_URL is configured (same-origin
// next-auth URLs, real handlers on the API app). The frontend owns zero API
// routes and never does CORS/CSRF — that is the backend proxy's job.

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

beforeAll(async () => {
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://localhost:5010";
  jest.isolateModules(() => {
    const mod = require("@/proxy") as { default: typeof handler };
    handler = mod.default;
  });
});

afterAll(() => {
  delete process.env.NEXT_PUBLIC_API_BASE_URL;
});

beforeEach(() => {
  getToken.mockReset().mockResolvedValue({ id: "u1" });
});

describe("page auth", () => {
  it("redirects unauthenticated page visits to signin", async () => {
    getToken.mockResolvedValue(null);
    const res = await handler(req("/settings"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/auth/signin");
  });

  it("lets authenticated pages through", async () => {
    const res = await handler(req("/settings"));
    expect(res.status).toBe(200);
  });

  it("never guards static assets or auth pages", async () => {
    getToken.mockResolvedValue(null);
    expect((await handler(req("/logo.png"))).status).toBe(200);
    expect((await handler(req("/auth/signin"))).status).toBe(200);
  });
});

describe("backend rewrites", () => {
  it("rewrites /api/auth/* to the backend origin (same-origin OAuth URLs)", async () => {
    const res = await handler(req("/api/auth/signin/google"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-rewrite")).toContain("http://localhost:5010/api/auth/signin/google");
  });

  it("rewrites /api/dev/* too (dev session cookie is minted on the backend)", async () => {
    const res = await handler(req("/api/dev/session?action=login"));
    expect(res.headers.get("x-middleware-rewrite")).toContain("http://localhost:5010/api/dev/session");
  });

  it("rewrites carry query strings (next-auth callbackUrl etc.)", async () => {
    const res = await handler(req("/api/auth/callback/google?code=abc"));
    expect(res.headers.get("x-middleware-rewrite")).toContain("code=abc");
  });
});
