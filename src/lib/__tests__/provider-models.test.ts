// provider-models.test.ts — The BYOK model-listing engine: request building
// per auth style, response normalization, filters, cache, friendly errors,
// and the budget-guarded verify pass.

jest.mock("../model-catalog", () => {
  const actual = jest.requireActual("../model-catalog");
  return {
    ...actual,
    probeModel: jest.fn(),
  };
});

import { buildListRequest, listProviderModels, verifyProviderModels, clearProviderModelsCache, cacheKeyFor } from "../provider-models";
import { getProviderDef } from "../provider-registry";
import { probeModel } from "../model-catalog";

const mockedProbe = probeModel as jest.Mock;

const fetchMock = jest.fn();

beforeEach(() => {
  clearProviderModelsCache();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  mockedProbe.mockReset();
});

afterEach(() => {
  // @ts-expect-error restore
  delete global.fetch;
});

const okList = (models: unknown[]) => ({
  ok: true,
  status: 200,
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => ({ data: models }),
});

describe("buildListRequest", () => {
  it("uses Bearer auth for bearer-style providers", () => {
    const def = getProviderDef("groq")!;
    const req = buildListRequest(def);
    expect(req.url).toBe("https://api.groq.com/openai/v1/models");
    expect(req.headers["Authorization"]).toBe("Bearer __KEY__");
    expect(req.headers["x-api-key"]).toBeUndefined();
  });

  it("uses x-api-key + anthropic-version for Anthropic", () => {
    const def = getProviderDef("anthropic")!;
    const req = buildListRequest(def);
    expect(req.url).toBe("https://api.anthropic.com/v1/models");
    expect(req.headers["x-api-key"]).toBe("__KEY__");
    expect(req.headers["anthropic-version"]).toBeTruthy();
    expect(req.headers["Authorization"]).toBeUndefined();
  });
});

describe("listProviderModels", () => {
  it("normalizes ids/names/context and filters non-chat models", async () => {
    fetchMock.mockResolvedValueOnce(
      okList([
        { id: "llama-3.3-70b", name: "Llama", context_window: 131072 },
        { id: "whisper-large", name: "Whisper" },
        { id: "guard-classifier" },
        { id: "llama-3.3-70b" }, // duplicate id
      ])
    );
    const r = await listProviderModels("cerebras", "csk-test");
    expect(r.ok).toBe(true);
    expect(r.models).toHaveLength(1);
    expect(r.models[0]).toMatchObject({ id: "llama-3.3-70b", contextWindow: 131072 });
  });

  it("flags openrouter :free models", async () => {
    fetchMock.mockResolvedValueOnce(okList([{ id: "qwen/qwen3.8-27b:free" }, { id: "openai/gpt-4o" }]));
    const r = await listProviderModels("openrouter", "sk-or-test");
    expect(r.models.find((m) => m.id === "qwen/qwen3.8-27b:free")?.free).toBe(true);
    expect(r.models.find((m) => m.id === "openai/gpt-4o")?.free).toBe(false);
  });

  it("caps the list at 200", async () => {
    const many = Array.from({ length: 260 }, (_, i) => ({ id: `m-${i}` }));
    fetchMock.mockResolvedValueOnce(okList(many));
    const r = await listProviderModels("mistral", "mk-test");
    expect(r.models).toHaveLength(200);
  });

  it("maps 401 to a friendly error without echoing the key", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    const key = "super-secret-key-123";
    const r = await listProviderModels("groq", key);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/rejected/i);
    expect(JSON.stringify(r)).not.toContain(key);
  });

  it("warns on prefix mismatch when the provider accepts anyway", async () => {
    fetchMock.mockResolvedValueOnce(okList([{ id: "some-model" }]));
    const r = await listProviderModels("nvidia", "not-an-nvapi-key");
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/nvapi-/);
  });

  it("caches per (provider, key) for repeat calls", async () => {
    fetchMock.mockResolvedValue(okList([{ id: "a-model" }]));
    const first = await listProviderModels("groq", "gsk-cache");
    const second = await listProviderModels("groq", "gsk-cache");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    // Different key → different cache entry.
    await listProviderModels("groq", "gsk-other");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cacheKeyFor("groq", "gsk-cache")).not.toBe(cacheKeyFor("groq", "gsk-other"));
  });

  it("treats empty listings as a soft failure with manual fallback hint", async () => {
    fetchMock.mockResolvedValueOnce(okList([]));
    const r = await listProviderModels("together", "tk-test");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/manually/i);
  });
});

describe("verifyProviderModels", () => {
  it("probes within budget, spaces calls, and 429 counts as alive", async () => {
    mockedProbe.mockImplementation((_p: string, id: string) =>
      Promise.resolve(id === "dead-model" ? "dead" : id === "busy-model" ? "rate_limited" : "ok")
    );
    const models = [
      { id: "dead-model", name: "Dead" },
      { id: "busy-model", name: "Busy" },
      { id: "alive-model", name: "Alive" },
    ];
    const r = await verifyProviderModels("groq", "gsk-verify", models);
    expect(r.ok).toBe(true);
    expect(r.probedCount).toBe(3);
    expect(r.verifiedCount).toBe(2);
    expect(r.models.find((m) => m.id === "busy-model")?.verified).toBe(true);
    expect(r.models.find((m) => m.id === "dead-model")?.verified).toBeUndefined();
  });
});
