// proxy-frontend.test.ts — The FRONTEND proxy (src/proxy.ts) in the physical
// split: page routes redirect to signin without a session, authenticated pages
// pass through, and /api/auth + /api/dev are transparently rewritten to the
// backend origin when NEXT_PUBLIC_API_BASE_URL is configured (same-origin
// next-auth URLs, real handlers on the API app). When the cloud origin is
// UNREACHABLE (no internet / backend down), the auth heartbeat routes get a
// JSON 503 (x-orplex-offline) instead of a plain-text 500 — that is what the
// next-auth client can parse without blowing up as CLIENT_FETCH_ERROR.
// The frontend owns zero API routes and never does CORS/CSRF — that is the
// backend proxy's job.

// Module scope: without any import/export this file is a global script and its
// top-level names collide with proxy-cors.test.ts (TS2451). This export
// makes it a module — zero runtime effect.
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

// Load a FRESH proxy module per scenario: reachability is memoized at module
// scope (30s ok / 5s fail), so each describe block re-requires the module
// with its own fetch mock installed to get a deterministic probe result.
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
  getToken.mockReset().mockResolvedValue({ id: "u1" });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("page auth (cloud reachable)", () => {
  beforeEach(() => {
    jest.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    loadProxy();
  });

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

  it("never guards static assets or the signin page (frontend-owned page)", async () => {
    getToken.mockResolvedValue(null);
    expect((await handler(req("/logo.png"))).status).toBe(200);
    // The sign-in page renders in the UI app itself — no redirect to the
    // backend; the page's own /api/auth + /api/dev calls are rewritten there.
    const signin = await handler(req("/auth/signin"));
    expect(signin.status).toBe(200);
  });
});

describe("backend rewrites (cloud reachable)", () => {
  beforeEach(() => {
    jest.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    loadProxy();
  });

  it("serves the frontend-owned sign-in page without redirecting", async () => {
    const res = await handler(req("/auth/signin"));
    expect(res.status).toBe(200);
  });

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

  it("keeps /api/system/memory local (must read THIS machine's RAM, not the backend host)", async () => {
    const res = await handler(req("/api/system/memory"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.status).toBe(200);
  });
});

describe("cloud unreachable (offline)", () => {
  beforeEach(() => {
    // DNS dead / connection refused: the probe fetch throws.
    jest.spyOn(global, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    loadProxy();
  });

  it("answers the auth heartbeat with a parseable JSON 503, not a text 500", async () => {
    const res = await handler(req("/api/auth/session"));
    expect(res.status).toBe(503);
    expect(res.headers.get("x-orplex-offline")).toBe("1");
    const body = await res.json();
    expect(body.error).toBe("offline");
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
  });

  it("covers /api/dev/* with the offline JSON too", async () => {
    const res = await handler(req("/api/dev/session"));
    expect(res.status).toBe(503);
    expect(res.headers.get("x-orplex-offline")).toBe("1");
  });

  it("still rewrites non-heartbeat API routes (app code handles its own offline UX)", async () => {
    const res = await handler(req("/api/models"));
    expect(res.headers.get("x-middleware-rewrite")).toContain("http://localhost:5010/api/models");
  });

  it("keeps conversations LOCAL-FIRST (desktop: on-device store, no cloud rewrite)", async () => {
    // Local-first cut-over: the list/create route is served in THIS app (the
    // Electron bridge / the migration route own it). It must never be
    // rewritten to the backend again — a rewrite here would resurrect cloud
    // writes the desktop no longer owns and split threads across stores.
    const res = await handler(req("/api/conversations"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    // ...and so are the dynamic children (rename/delete/fork/migrate).
    expect((await handler(req("/api/conversations/abc"))).headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("keeps guarding pages by auth while offline (redirect to signin)", async () => {
    getToken.mockResolvedValue(null);
    const res = await handler(req("/settings"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/auth/signin");
  });
});
