// byok-credentials.test.ts — The run user must actually get their own key.
//
// Regression cover for: the server executor resolved credentials from
// process.env only, so a user who had paid for and configured a key in
// Settings got it honoured in chat and completely IGNORED in background runs —
// which then silently executed on the platform's free shared key against a
// model they never picked.

const mockUserApiKey = { findMany: jest.fn() };
jest.mock("../prisma", () => ({ prisma: { userApiKey: mockUserApiKey } }));

const mockDecrypt = jest.fn();
jest.mock("../key-encryption", () => ({ decryptKey: (...a: unknown[]) => mockDecrypt(...a) }));

import { resolveRunCredential } from "../byok-credentials";

beforeEach(() => {
  jest.clearAllMocks();
  mockDecrypt.mockReturnValue("decrypted-key");
});

const row = (over: Record<string, unknown> = {}) => ({
  id: "k1",
  provider: "openai",
  apiKey: "enc",
  model: "gpt-4o",
  modelsCache: [{ id: "gpt-4o" }],
  ...over,
});

describe("resolveRunCredential", () => {
  it("returns the user's own paid key, not a platform env fallback", async () => {
    mockUserApiKey.findMany.mockResolvedValue([row({ provider: "openai" })]);
    const c = await resolveRunCredential("u1");
    expect(c).toMatchObject({ provider: "openai", apiKey: "decrypted-key", isFreeTier: false });
  });

  it("prefers a key whose own catalogue contains the requested model", async () => {
    mockUserApiKey.findMany.mockResolvedValue([
      row({ id: "k1", provider: "openai", modelsCache: [{ id: "gpt-4o" }] }),
      row({ id: "k2", provider: "anthropic", modelsCache: [{ id: "claude-sonnet-4-20250514" }] }),
    ]);
    const c = await resolveRunCredential("u1", "claude-sonnet-4-20250514");
    expect(c?.provider).toBe("anthropic");
  });

  it("matches across a namespace (OpenRouter `openai/gpt-4o` vs bare id)", async () => {
    mockUserApiKey.findMany.mockResolvedValue([
      row({ id: "k1", provider: "openrouter", modelsCache: [{ id: "openai/gpt-4o" }] }),
    ]);
    const c = await resolveRunCredential("u1", "gpt-4o");
    expect(c?.provider).toBe("openrouter");
  });

  it("flags a free-tier-only provider so free-tier shaping still applies", async () => {
    mockUserApiKey.findMany.mockResolvedValue([row({ provider: "groq" })]);
    const c = await resolveRunCredential("u1");
    expect(c?.isFreeTier).toBe(true);
  });

  it("skips an undecryptable key instead of throwing", async () => {
    mockDecrypt.mockImplementation(() => {
      throw new Error("secret rotated");
    });
    await expect(resolveRunCredential("u1")).resolves.toBeNull();
  });

  it("skips a provider that is no longer in the registry", async () => {
    mockUserApiKey.findMany.mockResolvedValue([row({ provider: "retired-provider" })]);
    await expect(resolveRunCredential("u1")).resolves.toBeNull();
  });

  it("never throws when the DB is down (caller falls back to env)", async () => {
    mockUserApiKey.findMany.mockRejectedValue(new Error("db down"));
    await expect(resolveRunCredential("u1")).resolves.toBeNull();
  });

  it("returns null (not a crash) for an empty user id", async () => {
    await expect(resolveRunCredential("")).resolves.toBeNull();
    expect(mockUserApiKey.findMany).not.toHaveBeenCalled();
  });
});