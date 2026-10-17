/**
 * /api/models/available response cache — behavioural tests.
 *
 * The handler caches the built response for 5s to collapse the picker's poll
 * burst. The response carries the CALLER'S BYOK model list, so the cache key
 * must be the authenticated user id: a shared key would serve one user's API
 * keys (and therefore their model listings) to another. That is a cross-tenant
 * data leak, so it is asserted directly here rather than inferred.
 */

const mockRequireAuth = jest.fn();
const mockFindMany = jest.fn();
const mockGetVerifiedModels = jest.fn();
const mockEnsureCatalogsFresh = jest.fn();

jest.mock("@/lib/chat-middleware", () => ({
  requireAuth: (...a: unknown[]) => mockRequireAuth(...a),
}));

jest.mock("@/lib/prisma", () => ({
  prisma: { userApiKey: { findMany: (...a: unknown[]) => mockFindMany(...a) } },
}));

jest.mock("@/lib/model-catalog", () => ({
  getVerifiedModels: (...a: unknown[]) => mockGetVerifiedModels(...a),
  modelHealth: () => "green",
}));

jest.mock("@/lib/catalog-sync", () => ({
  ensureCatalogsFresh: (...a: unknown[]) => mockEnsureCatalogsFresh(...a),
}));

jest.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    try {
      void fn();
    } catch {
      /* outside a request scope */
    }
  },
}));

type Route = { GET: (req: unknown) => Promise<Response> };

async function loadRoute(): Promise<Route> {
  jest.resetModules();
  return (await import("@/app/api/models/available/route")) as unknown as Route;
}

const REQ = { headers: new Headers() } as unknown;

function keyRow(provider: string, models: string[]) {
  return {
    provider,
    modelsCache: models.map((id) => ({ id, name: id, contextWindow: 1000, free: false })),
    modelsFetchedAt: new Date(1_700_000_000_000),
    createdAt: new Date(1_600_000_000_000),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEnsureCatalogsFresh.mockResolvedValue(undefined);
  mockGetVerifiedModels.mockResolvedValue({
    models: [{ id: "platform/model-a", name: "A", provider: "openrouter", lastVerifiedAt: new Date().toISOString() }],
    throttledModels: [],
    probedAt: new Date().toISOString(),
    providers: ["openrouter"],
    providerIssues: [],
  });
});

describe("/api/models/available response cache", () => {
  it("returns 401-style auth failure without touching the cache", async () => {
    const { GET } = await loadRoute();
    mockRequireAuth.mockResolvedValue({ ok: false, response: new Response("nope", { status: 401 }) });
    const res = await GET(REQ);
    expect(res.status).toBe(401);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("serves the BYOK models for the authenticated user", async () => {
    const { GET } = await loadRoute();
    mockRequireAuth.mockResolvedValue({ ok: true, userId: "user-1" });
    mockFindMany.mockResolvedValue([keyRow("groq", ["groq/model-x"])]);
    const body = await (await GET(REQ)).json();
    expect(body.success).toBe(true);
    expect(body.userModels.map((m: { id: string }) => m.id)).toEqual(["groq/model-x"]);
  });

  it("never leaks one user's BYOK models to another", async () => {
    const { GET } = await loadRoute();

    mockRequireAuth.mockResolvedValue({ ok: true, userId: "alice" });
    mockFindMany.mockResolvedValue([keyRow("groq", ["alice-secret-model"])]);
    const asAlice = await (await GET(REQ)).json();

    // Bob's request happens INSIDE alice's 5s TTL. A globally-keyed cache would
    // hand him alice's keys here.
    mockRequireAuth.mockResolvedValue({ ok: true, userId: "bob" });
    mockFindMany.mockResolvedValue([keyRow("openai", ["bob-model"])]);
    const asBob = await (await GET(REQ)).json();

    expect(asAlice.userModels.map((m: { id: string }) => m.id)).toEqual(["alice-secret-model"]);
    expect(asBob.userModels.map((m: { id: string }) => m.id)).toEqual(["bob-model"]);
    expect(JSON.stringify(asBob)).not.toContain("alice-secret-model");
  });

  it("collapses a poll burst into one query for the same user", async () => {
    const { GET } = await loadRoute();
    mockRequireAuth.mockResolvedValue({ ok: true, userId: "user-1" });
    mockFindMany.mockResolvedValue([keyRow("groq", ["groq/model-x"])]);

    await GET(REQ);
    await GET(REQ);
    await GET(REQ);

    // The whole point of the cache: one DB round-trip for three polls.
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it("re-queries once the TTL has passed", async () => {
    const { GET } = await loadRoute();
    mockRequireAuth.mockResolvedValue({ ok: true, userId: "user-1" });
    mockFindMany.mockResolvedValue([keyRow("groq", ["groq/model-x"])]);

    await GET(REQ);
    jest.useFakeTimers();
    jest.advanceTimersByTime(5_001);
    await GET(REQ);
    jest.useRealTimers();

    expect(mockFindMany).toHaveBeenCalledTimes(2);
  });

  it("a freshly added key surfaces as soon as the TTL expires", async () => {
    const { GET } = await loadRoute();
    mockRequireAuth.mockResolvedValue({ ok: true, userId: "user-1" });
    mockFindMany.mockResolvedValue([keyRow("groq", ["groq/model-x"])]);

    const first = await (await GET(REQ)).json();
    expect(first.keysRev).not.toBe("");

    // User adds a key; the revision marker changes.
    mockFindMany.mockResolvedValue([
      keyRow("groq", ["groq/model-x"]),
      { ...keyRow("openai", ["openai/model-y"]), createdAt: new Date(1_800_000_000_000) },
    ]);
    jest.useFakeTimers();
    jest.advanceTimersByTime(5_001);
    const second = await (await GET(REQ)).json();
    jest.useRealTimers();

    expect(second.keysRev).not.toBe(first.keysRev);
    expect(second.userModels.map((m: { id: string }) => m.id)).toContain("openai/model-y");
  });

  it("does not cache the empty fallback after a transient failure", async () => {
    const { GET } = await loadRoute();
    mockRequireAuth.mockResolvedValue({ ok: true, userId: "user-1" });
    mockGetVerifiedModels.mockRejectedValueOnce(new Error("catalog down"));

    const failed = await (await GET(REQ)).json();
    expect(failed.models).toEqual([]);

    // The next call must re-query rather than serve the empty body for the TTL.
    mockGetVerifiedModels.mockResolvedValue({
      models: [{ id: "platform/model-a", name: "A", provider: "openrouter", lastVerifiedAt: new Date().toISOString() }],
      throttledModels: [],
      probedAt: new Date().toISOString(),
      providers: ["openrouter"],
      providerIssues: [],
    });
    const recovered = await (await GET(REQ)).json();
    expect(recovered.models.length).toBeGreaterThan(0);
  });
});