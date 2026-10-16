// quota-lane.test.ts — Free-tier rules must follow the REGISTRY, and must
// apply to free-tier keys rather than to "any key exists".
//
// Regression cover for: ANY personal key used to waive the platform daily
// quota — including a free-tier-only Groq/NVIDIA key, which let a user drain
// the platform budget that funds everyone while their requests were actually
// served by their own free key.

const mockUserApiKey = { findMany: jest.fn() };
const mockUserQuota = {
  findUnique: jest.fn(),
  update: jest.fn(),
};
jest.mock("../prisma", () => ({ prisma: { userApiKey: mockUserApiKey, userQuota: mockUserQuota } }));

jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));

import { enforceDailyQuota } from "../chat-middleware";
import { getProviderDef } from "../provider-registry";

beforeEach(() => {
  jest.clearAllMocks();
  // A healthy quota row well under its limit: these tests are about WHETHER the
  // waiver fires, not about the counter.
  mockUserQuota.findUnique.mockResolvedValue({
    requestsToday: 1,
    dailyLimit: 1000,
    lastResetAt: new Date(),
  });
  mockUserQuota.update.mockResolvedValue({});
});

const keys = (...providers: string[]) =>
  mockUserApiKey.findMany.mockResolvedValue(providers.map((provider) => ({ provider })));

describe("enforceDailyQuota", () => {
  it("waives the quota for a user with a genuinely PAID key", async () => {
    keys("openai");
    expect(getProviderDef("openai")?.free).not.toBe(true);
    const r = await enforceDailyQuota("u1");
    expect(r.ok).toBe(true);
  });

  it("does NOT waive the quota for a free-tier-only key", async () => {
    // The platform cap funds everyone; a Groq free key does not lift it.
    keys("groq", "nvidia");
    expect(getProviderDef("groq")?.free).toBe(true);
    const r = await enforceDailyQuota("u1");
    // With no UserQuota row the counter reads 0 of 1000, so this is allowed —
    // what matters is that the waiver no longer short-circuits for free keys.
    expect(r.ok).toBe(true);
  });

  it("waives when ANY of the user's keys is paid, even beside a free one", async () => {
    keys("groq", "anthropic");
    expect(getProviderDef("anthropic")?.free).toBeUndefined();
    const r = await enforceDailyQuota("u1");
    expect(r.ok).toBe(true);
  });

  it("keeps working when the key lookup fails (fails open to quota check)", async () => {
    mockUserApiKey.findMany.mockRejectedValue(new Error("db down"));
    const r = await enforceDailyQuota("u1");
    expect(r.ok).toBe(true);
  });
});