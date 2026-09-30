// api-base.test.ts — The split-deployment seam: path prefixing, credential
// and CSRF-header injection on apiFetch, and the apiJson error envelope.

import { withApiBase, apiFetch, apiJson, API_BASE } from "../api-base";

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  delete (global as { fetch?: unknown }).fetch;
});

describe("withApiBase", () => {
  it("returns the path untouched when no base is configured", () => {
    // Test env has NEXT_PUBLIC_API_BASE_URL unset → same-origin mode.
    expect(API_BASE).toBe("");
    expect(withApiBase("/api/chat")).toBe("/api/chat");
  });

  it("passes through non-relative paths", () => {
    expect(withApiBase("https://elsewhere.example/api")).toBe("https://elsewhere.example/api");
  });
});

describe("apiFetch", () => {
  it("injects X-Requested-With and credentials", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await apiFetch("/api/ping");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/ping");
    expect(init.credentials).toBe("include");
    expect(init.headers.get("X-Requested-With")).toBe("fetch");
  });

  it("lets callers override headers and credentials", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await apiFetch("/api/ping", {
      headers: { "X-Custom": "1", "Content-Type": "application/json" },
      credentials: "same-origin",
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.credentials).toBe("same-origin");
    expect(init.headers.get("X-Custom")).toBe("1");
    expect(init.headers.get("Content-Type")).toBe("application/json");
    expect(init.headers.get("X-Requested-With")).toBe("fetch");
  });

  it("forwards method and body", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await apiFetch("/api/settings/keys", { method: "POST", body: JSON.stringify({ a: 1 }) });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"a":1}');
  });
});

describe("apiJson", () => {
  it("returns parsed data on 2xx", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, models: [1, 2] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const r = await apiJson<{ success: boolean; models: number[] }>("/api/x");
    expect(r.ok).toBe(true);
    expect(r.data?.models).toEqual([1, 2]);
    expect(r.error).toBeNull();
  });

  it("surfaces the server's error message on non-2xx without throwing", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: { message: "Key rejected" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    );
    const r = await apiJson("/api/x");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.error).toBe("Key rejected");
  });

  it("handles string-shaped errors and non-JSON bodies", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "plain" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    expect((await apiJson("/api/x")).error).toBe("plain");

    fetchMock.mockResolvedValue(new Response("<html>", { status: 500 }));
    expect((await apiJson("/api/x")).error).toBe("HTTP 500");
  });

  it("resolves with a network error instead of throwing", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const r = await apiJson("/api/x");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toBe("Failed to fetch");
  });
});
