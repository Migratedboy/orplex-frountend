// proxy-cors.test.ts — The BACKEND proxy (backend/src/proxy.ts) is the
// API-only gatekeeper of the physical split:
// preflights for /api/* must pass with credentialed CORS for allowed origins,
// state-changing calls need CSRF headers, and human page hits get the cheap
// JSON api-only identity instead of a UI bundle (page auth is the FRONTEND
// proxy's job — the backend never redirects to signin).

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

describe("API-only identity (always on — this app ships no UI)", () => {
  it("answers human page hits with the JSON api-only stub", async () => {
    getToken.mockResolvedValue(null);
    const res = await handler(req({ path: "/settings" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.status).toBe("api-only");
    expect(body.service).toBe("orplex-backend");
    expect(body.health).toBe("/api/health");
    expect(res.headers.get("location")).toBeNull(); // never a signin redirect here
  });

  it("still answers page preflights with CORS", async () => {
    const res = await handler(req({ path: "/settings", method: "OPTIONS", origin: "http://localhost:5100" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5100");
  });

  it("API routes are completely unaffected (200, no stub, no redirect)", async () => {
    getToken.mockResolvedValue(null);
    const res = await handler(req({ path: "/api/models/available", origin: "http://localhost:5100" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5100");
    expect(res.headers.get("location")).toBeNull();
  });
});
