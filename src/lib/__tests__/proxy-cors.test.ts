// middleware-cors.test.ts — The proxy (src/proxy.ts, formerly middleware.ts)
// is the split-deployment gatekeeper:
// preflights for /api/* must pass with credentialed CORS for allowed origins,
// state-changing calls need CSRF headers, page routes redirect without a
// session, and API routes never redirect (they self-authenticate).

const middleware = jest.fn();
const getToken = jest.fn();

jest.mock("next-auth/jwt", () => ({
  getToken: (...args: unknown[]) => getToken(...args),
}));

let handler: (req: unknown) => Promise<Response>;

function req(partial: {
  path: string;
  method?: string;
  origin?: string | null;
  contentType?: string | null;
  xhr?: string | null;
}) {
  const url = new URL(`http://localhost:5000${partial.path}`);
  const headers = new Headers();
  if (partial.origin !== null && partial.origin !== undefined) headers.set("origin", partial.origin);
  if (partial.contentType) headers.set("content-type", partial.contentType);
  if (partial.xhr) headers.set("x-requested-with", partial.xhr);
  return {
    method: partial.method ?? "GET",
    url: url.toString(),
    nextUrl: url,
    headers,
  } as unknown as Parameters<typeof handler>[0];
}

beforeAll(async () => {
  process.env.ALLOWED_ORIGINS = "http://localhost:5000,http://localhost:5100";
  delete process.env.NEXT_PUBLIC_API_BASE_URL;
  jest.isolateModules(() => {
    const mod = require("../../proxy") as { default: typeof handler };
    handler = mod.default;
  });
});

beforeEach(() => {
  getToken.mockReset().mockResolvedValue({ id: "u1" });
});

describe("CORS", () => {
  it("answers API preflights with 204 + credentials for allowed origins", async () => {
    const res = await handler(req({ path: "/api/chat", method: "OPTIONS", origin: "http://localhost:5100" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5100");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-allow-headers")).toContain("X-Requested-With");
  });

  it("echoes allowed origins on real API calls with credentials", async () => {
    const res = await handler(req({ path: "/api/models/available", origin: "http://localhost:5100" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5100");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("does NOT echo disallowed origins", async () => {
    const res = await handler(req({ path: "/api/models/available", origin: "http://evil.example" }));
    expect(res.headers.get("access-control-allow-origin")).not.toBe("http://evil.example");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("CSRF", () => {
  it("rejects JSON POSTs from disallowed origins", async () => {
    const res = await handler(req({
      path: "/api/settings/keys", method: "POST",
      origin: "http://evil.example", contentType: "application/json",
    }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe("Origin not allowed");
  });

  it("accepts JSON POSTs from allowed origins", async () => {
    const res = await handler(req({
      path: "/api/settings/keys", method: "POST",
      origin: "http://localhost:5100", contentType: "application/json",
    }));
    expect(res.status).toBe(200);
  });

  it("accepts POSTs with the X-Requested-With header", async () => {
    const res = await handler(req({
      path: "/api/settings/keys", method: "POST",
      origin: "http://localhost:5100", xhr: "fetch",
    }));
    expect(res.status).toBe(200);
  });

  it("rejects POSTs without CSRF headers", async () => {
    const res = await handler(req({
      path: "/api/settings/keys", method: "POST",
      origin: "http://localhost:5000", contentType: null,
    }));
    expect(res.status).toBe(403);
  });
});

describe("page auth", () => {
  it("redirects unauthenticated page visits to signin", async () => {
    getToken.mockResolvedValue(null);
    const res = await handler(req({ path: "/settings" }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/auth/signin");
  });

  it("lets authenticated pages through", async () => {
    const res = await handler(req({ path: "/settings" }));
    expect(res.status).toBe(200);
  });

  it("NEVER redirects API routes to signin (they self-authenticate)", async () => {
    getToken.mockResolvedValue(null);
    const res = await handler(req({ path: "/api/models/available", origin: "http://localhost:5100" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("BACKEND_ONLY=1 (api-only deployment)", () => {
  beforeAll(async () => {
    process.env.BACKEND_ONLY = "1";
    jest.isolateModules(() => {
      const mod = require("../../proxy") as { default: typeof handler };
      handler = mod.default;
    });
  });

  afterAll(() => {
    delete process.env.BACKEND_ONLY;
  });

  it("serves a JSON api-only stub instead of page UI", async () => {
    const res = await handler(req({ path: "/settings" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.status).toBe("api-only");
    expect(body.service).toBe("orplex-backend");
    expect(body.health).toBe("/api/health");
  });

  it("still answers page preflights with CORS (frontend may ship only assets)", async () => {
    const res = await handler(req({ path: "/settings", method: "OPTIONS", origin: "http://localhost:5100" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5100");
  });

  it("API routes are completely unaffected (200, no stub)", async () => {
    const res = await handler(req({ path: "/api/models/available", origin: "http://localhost:5100" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5100");
  });
});
