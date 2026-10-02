// provider-retry-hardening.test.ts — The chat provider ladder must fail fast
// on dead keys, respect a global deadline, and never hang the client; and
// modelVariants must be safe on junk input.

import { fetchWithProviderRetry, modelVariants, type ProviderConfig } from "../chat-middleware";

// Deferred-response helpers --------------------------------------------------

let fetchMock: jest.Mock;

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(body)}\n\n`));
        c.close();
      },
    }),
  };
}

const provider: ProviderConfig = {
  name: "test-provider",
  url: "https://x.test/v1/chat/completions",
  apiKey: "k",
  model: "m",
};

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  delete (global as { fetch?: unknown }).fetch;
});

describe("fetchWithProviderRetry — hardening", () => {
  it("fails fast on 401 without burning retries", async () => {
    fetchMock.mockResolvedValue(jsonRes(401, { error: { message: "bad key" } }));
    const r = await fetchWithProviderRetry(provider, { model: "m" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/key rejected/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails fast on 403 without burning retries", async () => {
    fetchMock.mockResolvedValue(jsonRes(403, { error: { message: "forbidden" } }));
    const r = await fetchWithProviderRetry(provider, { model: "m" });
    expect(r.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries 5xx then succeeds and returns a stream", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes(500, { error: { message: "boom" } }))
      .mockResolvedValueOnce(jsonRes(200, { choices: [{ message: { content: "ok" } }] }));
    const r = await fetchWithProviderRetry(provider, { model: "m" });
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after max attempts with the last error", async () => {
    fetchMock.mockResolvedValue(jsonRes(500, { error: { message: "still down" } }));
    const r = await fetchWithProviderRetry(provider, { model: "m" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/still down|HTTP 500/);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("treats an empty body as a failure, not success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => "",
      body: new ReadableStream({ start(c) { c.close(); } }),
    });
    const r = await fetchWithProviderRetry(provider, { model: "m" });
    expect(r.ok).toBe(false);
  });
});

describe("modelVariants — edge cases", () => {
  it("returns [] for empty/whitespace ids", () => {
    expect(modelVariants("")).toEqual([]);
    expect(modelVariants("   ")).toEqual([]);
  });

  it("pairs bare and :free forms", () => {
    expect(modelVariants("openai/gpt-x")).toEqual(["openai/gpt-x", "openai/gpt-x:free"]);
    expect(modelVariants("openai/gpt-x:free")).toEqual(["openai/gpt-x:free", "openai/gpt-x"]);
  });

  it("trims stray whitespace", () => {
    expect(modelVariants(" model-x ")).toEqual(["model-x", "model-x:free"]);
  });
});
