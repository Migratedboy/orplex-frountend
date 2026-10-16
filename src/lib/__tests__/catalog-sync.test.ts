// catalog-sync.test.ts — Autonomous BYOK catalogue maintenance.
//
// The failure this guards against is silent: a key sits with an empty
// modelsCache forever because nobody pressed "Fetch models", so the picker
// looks broken while the engine is perfectly capable.

const mockUserApiKey = {
  findFirst: jest.fn(),
  findMany: jest.fn(),
  updateMany: jest.fn(),
};

jest.mock("../prisma", () => ({
  prisma: { userApiKey: mockUserApiKey },
}));

jest.mock("../key-encryption", () => ({
  decryptKey: jest.fn(() => "sk-or-decrypted"),
}));

jest.mock("../model-catalog", () => ({
  NON_CHAT_RE: /(whisper|embed|guard-)/i,
  probeModel: jest.fn(),
  lastProbeFailure: jest.fn(() => ({ kind: null, detail: "" })),
}));

const mockList = jest.fn();
jest.mock("../provider-models", () => ({
  listProviderModels: (...args: unknown[]) => mockList(...args),
}));

import { syncKeyCatalog, ensureCatalogsFresh, CATALOG_STALE_MS } from "../catalog-sync";
import { decryptKey } from "../key-encryption";

const mockedDecrypt = decryptKey as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockUserApiKey.updateMany.mockResolvedValue({ count: 1 });
  mockUserApiKey.findMany.mockResolvedValue([]);
  mockedDecrypt.mockReturnValue("sk-or-decrypted");
});

describe("syncKeyCatalog", () => {
  it("fetches the whole catalogue and persists it against the owner's key", async () => {
    mockUserApiKey.findFirst.mockResolvedValue({ id: "k1", provider: "openrouter", apiKey: "enc" });
    mockList.mockResolvedValue({ ok: true, models: [{ id: "a" }, { id: "b" }], listedTotal: 2 });

    const r = await syncKeyCatalog("u1", "k1");

    expect(r.synced).toBe(true);
    expect(r.count).toBe(2);
    // Ownership is part of the lookup, so it must also be part of the write.
    expect(mockUserApiKey.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "k1", userId: "u1" },
        data: expect.objectContaining({ modelsFetchedAt: expect.any(Date) }),
      })
    );
  });

  it("never persists a catalogue for a key the user does not own", async () => {
    mockUserApiKey.findFirst.mockResolvedValue(null);
    const r = await syncKeyCatalog("u1", "someone-elses-key");
    expect(r.synced).toBe(false);
    expect(mockUserApiKey.updateMany).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  it("fails safely (no throw, no write) when the key cannot be decrypted", async () => {
    mockUserApiKey.findFirst.mockResolvedValue({ id: "k1", provider: "openrouter", apiKey: "enc" });
    mockedDecrypt.mockImplementation(() => {
      throw new Error("bad secret");
    });
    const r = await syncKeyCatalog("u1", "k1");
    expect(r.synced).toBe(false);
    expect(mockUserApiKey.updateMany).not.toHaveBeenCalled();
  });

  it("does not overwrite a good catalogue when listing fails", async () => {
    mockUserApiKey.findFirst.mockResolvedValue({ id: "k1", provider: "openrouter", apiKey: "enc" });
    mockList.mockResolvedValue({ ok: false, models: [], error: "Provider rate limit hit" });
    const r = await syncKeyCatalog("u1", "k1");
    expect(r.synced).toBe(false);
    expect(r.error).toMatch(/rate limit/i);
    // The cached catalogue must survive. A failure DOES stamp
    // modelsFetchedAt so ensureCatalogsFresh stops treating the key as
    // permanently due (it ran on every 5s picker poll, forever) — but it must
    // never write modelsCache.
    for (const call of mockUserApiKey.updateMany.mock.calls) {
      expect(call[0].data).not.toHaveProperty("modelsCache");
    }
  });

  it("never lets an exception escape into the request that triggered it", async () => {
    mockUserApiKey.findFirst.mockRejectedValue(new Error("db down"));
    await expect(syncKeyCatalog("u1", "k1")).resolves.toEqual({ synced: false, error: "db down" });
  });
});

describe("ensureCatalogsFresh", () => {
  it("only asks the DB for keys that are missing or stale", async () => {
    mockUserApiKey.findMany.mockResolvedValue([]);
    await ensureCatalogsFresh("u1");
    const where = mockUserApiKey.findMany.mock.calls[0][0].where;
    expect(where.userId).toBe("u1");
    expect(where.isActive).toBe(true);
    // A catalogue newer than the staleness window must never be re-fetched.
    expect(CATALOG_STALE_MS).toBeGreaterThan(60 * 60 * 1000);
    expect(JSON.stringify(where.OR)).toContain("modelsFetchedAt");
  });

  it("syncs the keys it was given and reports the totals", async () => {
    mockUserApiKey.findMany.mockResolvedValue([{ id: "k1" }, { id: "k2" }]);
    mockUserApiKey.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      provider: "groq",
      apiKey: "enc",
    }));
    mockList.mockResolvedValue({ ok: true, models: [{ id: "m" }], listedTotal: 1 });

    const results = await ensureCatalogsFresh("u1");
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.synced)).toBe(true);
  });

  it("returns nothing (and does not throw) when the DB is unreachable", async () => {
    mockUserApiKey.findMany.mockRejectedValue(new Error("db down"));
    await expect(ensureCatalogsFresh("u1")).resolves.toEqual([]);
  });
});