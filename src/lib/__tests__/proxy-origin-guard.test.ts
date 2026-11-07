// proxy-origin-guard.test.ts — cross-origin mutations must not reach the
// routes this process answers itself.
//
// src/proxy.ts serves two families of routes locally: the LOCAL_ONLY set (in
// every deployment mode) and ALL of /api/* when no backend origin is
// configured (self-hosted / Docker / next dev). Neither family ever reaches the
// backend's CSRF middleware, so before src/lib/same-origin.ts they had no
// origin check at all — the proxy's comment claimed "the BACKEND owns CORS +
// CSRF", which is only true for forwarded routes.
//
// SameSite=Lax cookies hide this today, but AUTH_COOKIE_SAMESITE=none is a
// supported split-deployment setting that removes that protection. These tests
// pin the layer that survives it, and pin that forwarded routes are NOT
// double-gated (a second gate there is what breaks form-encoded next-auth).

export {};

let handler: (req: unknown) => Promise<Response>;
const getToken = jest.fn();

jest.mock("next-auth/jwt", () => ({
  getToken: (...args: unknown[]) => getToken(...args),
}));

function req(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  base = "http://127.0.0.1:5000",
) {
  const url = new URL(`${base}${path}`);
  return {
    method,
    url: url.toString(),
    nextUrl: url,
    headers: new Headers(headers),
  } as unknown as Parameters<typeof handler>[0];
}

// Reachability (and the policy itself) is memoized at module scope, so each
// block re-requires the proxy with its own env in place.
function loadProxy() {
  jest.isolateModules(() => {
    const mod = require("@/proxy") as { default: typeof handler };
    handler = mod.default;
  });
}

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = "proxy-test-secret";
});

afterAll(() => {
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.NEXT_PUBLIC_API_BASE_URL;
  delete process.env.ORPLEX_API_URL;
});

beforeEach(() => {
  getToken.mockReset().mockResolvedValue({ id: "u1" });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("self-hosted mode: this process serves every /api route", () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    delete process.env.ORPLEX_API_URL;
    loadProxy();
  });

  it("refuses a cross-origin POST", async () => {
    const res = await handler(
      req("POST", "/api/agent/exec", { origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("origin_mismatch");
  });

  it("refuses a cross-origin DELETE", async () => {
    const res = await handler(
      req("DELETE", "/api/workspace/delete", { origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
  });

  it("allows the same-origin request through", async () => {
    const res = await handler(
      req("POST", "/api/agent/exec", { origin: "http://127.0.0.1:5000" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("allows non-browser callers that send no Origin and no Referer", async () => {
    // Electron main process, the stdio MCP proxy, cron with a bearer token,
    // curl: none of them can be driven by another site, and none ever carried
    // a CSRF token either.
    const res = await handler(req("POST", "/api/agent/exec"));
    expect(res.status).toBe(200);
  });

  it("falls back to Referer when Origin is absent", async () => {
    const allowed = await handler(
      req("POST", "/api/agent/exec", { referer: "http://127.0.0.1:5000/?tab=runs" }),
    );
    expect(allowed.status).toBe(200);

    const refused = await handler(
      req("POST", "/api/agent/exec", { referer: "https://evil.example/page" }),
    );
    expect(refused.status).toBe(403);
  });

  it("refuses a sandboxed frame (Origin: null)", async () => {
    const res = await handler(req("POST", "/api/agent/exec", { origin: "null" }));
    expect(res.status).toBe(403);
  });

  it("never blocks safe methods", async () => {
    const res = await handler(req("GET", "/api/agent/runs", { origin: "https://evil.example" }));
    expect(res.status).toBe(200);
  });

  it("treats localhost and 127.0.0.1 as the same origin on the same port", async () => {
    // The desktop serves the UI on 127.0.0.1 while in-app links may use
    // localhost; Windows resolves those to different addresses.
    const res = await handler(
      req("POST", "/api/agent/exec", { origin: "http://localhost:5000" }),
    );
    expect(res.status).toBe(200);
  });

  it("refuses a loopback origin on a DIFFERENT port", async () => {
    const res = await handler(
      req("POST", "/api/agent/exec", { origin: "http://127.0.0.1:9999" }),
    );
    expect(res.status).toBe(403);
  });

  it("accepts a forwarded host (desktop loopback chain)", async () => {
    const res = await handler(
      req(
        "POST",
        "/api/agent/exec",
        { origin: "http://localhost:5000", "x-forwarded-host": "localhost:5000" },
        "http://127.0.0.1:5000",
      ),
    );
    expect(res.status).toBe(200);
  });

  it("still sets the single CSP on pass-through responses", async () => {
    const res = await handler(req("GET", "/settings", {}, "http://127.0.0.1:5000"));
    const csp = res.headers.get("content-security-policy");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("fonts.googleapis.com");
  });

  it("does not let the renderer connect to the whole web", async () => {
    const res = await handler(req("GET", "/settings", {}, "http://127.0.0.1:5000"));
    const csp = res.headers.get("content-security-policy") || "";
    const connect = csp
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("connect-src")) || "";
    expect(connect.split(/\s+/)).not.toContain("https:");
    expect(connect).toContain("https://www.google.com");
  });
});

describe("split mode: forwarded routes keep the backend's CSRF layer", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = "http://localhost:5010";
    jest.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    loadProxy();
  });

  it("does NOT gate a forwarded route locally", async () => {
    // next-auth's own endpoints are form-encoded POSTs; a second origin gate
    // in front of the forward is exactly the failure documented in
    // docs/archive/BACKEND_CSRF_FIX_PROMPT.md.
    const res = await handler(
      req("POST", "/api/agent/exec", { origin: "https://evil.example" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-rewrite")).toContain(
      "http://localhost:5010/api/agent/exec",
    );
  });

  it("gates a LOCAL_ONLY route even in split mode (it never reaches the backend)", async () => {
    const res = await handler(
      req("POST", "/api/files", { origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
  });

  it("lets the same-origin LOCAL_ONLY request through to the local handler", async () => {
    const res = await handler(
      req("POST", "/api/files", { origin: "http://127.0.0.1:5000" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("gates a LOCAL_ONLY prefix route (/api/conversations/<id>)", async () => {
    const res = await handler(
      req("PATCH", "/api/conversations/abc", { origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
  });

  it("names BOTH the runtime and the build-time API base in connect-src", async () => {
    // The browser calls the base api-base.ts inlined at BUILD time; forwarding
    // prefers the runtime ORPLEX_API_URL. A policy naming only one of them
    // blocks every API call in the deployment where they differ.
    process.env.ORPLEX_API_URL = "https://api.internal.example";
    try {
      loadProxy();
      const res = await handler(req("GET", "/settings", {}, "http://127.0.0.1:5000"));
      const csp = res.headers.get("content-security-policy") || "";
      expect(csp).toContain("https://api.internal.example");
      expect(csp).toContain("http://localhost:5010");
    } finally {
      delete process.env.ORPLEX_API_URL;
    }
  });
});
