// catalog-ingest.test.ts — the serverless-catalog rescue store.
//
// Covers shape/caos handling of the published snapshot: hostile payloads
// must be rejected or capped, old snapshots must not roll back newer ones,
// and a corrupt/missing file must read as null.

import {
  readIngestedCatalog,
  resetIngestedCatalogForTests,
  writeIngestedCatalog,
  validateIngestedCatalog,
  ingestedIsFresherThan,
} from "../catalog-ingest";

const validPayload = {
  probedAt: "2026-10-25T08:00:00.000Z",
  providers: ["groq", "nvidia"],
  models: [
    { id: "openai/gpt-oss-120b", name: "GPT OSS 120B", provider: "groq", contextWindow: 131072, free: true },
  ],
  throttledModels: [{ id: "meta/llama-3.3-70b", name: "Llama", provider: "nvidia" }],
  providerIssues: [{ provider: "openrouter", kind: "empty", detail: "no models", count: 1 }],
};

describe("catalog-ingest", () => {
  beforeEach(() => resetIngestedCatalogForTests());

  it("writes and reads back a valid snapshot", () => {
    const res = writeIngestedCatalog(validPayload);
    expect(res.ok).toBe(true);
    const snap = readIngestedCatalog();
    expect(snap).not.toBeNull();
    expect(snap?.models[0].id).toBe("openai/gpt-oss-120b");
    expect(snap?.providers).toEqual(["groq", "nvidia"]);
    expect(snap?.probedAt).toBe("2026-10-25T08:00:00.000Z");
  });

  it("rejects unusable payloads without touching storage", () => {
    expect(writeIngestedCatalog(null)).toEqual({ ok: false, replaced: false });
    expect(writeIngestedCatalog({ models: [] })).toEqual({ ok: false, replaced: false });
    expect(writeIngestedCatalog({ models: validPayload.models, probedAt: "not-a-date" })).toEqual({
      ok: false,
      replaced: false,
    });
    expect(readIngestedCatalog()).toBeNull();
  });

  it("never rolls back to an older snapshot (monotonic probedAt)", () => {
    writeIngestedCatalog(validPayload);
    const older = { ...validPayload, probedAt: "2026-10-24T08:00:00.000Z" };
    const res = writeIngestedCatalog(older);
    expect(res.ok).toBe(true);
    expect(res.replaced).toBe(false);
    expect(readIngestedCatalog()?.probedAt).toBe("2026-10-25T08:00:00.000Z");
  });

  it("accepts a newer snapshot over an older stored one", () => {
    writeIngestedCatalog(validPayload);
    const newer = { ...validPayload, probedAt: "2026-10-26T08:00:00.000Z", models: validPayload.models };
    const res = writeIngestedCatalog(newer);
    expect(res.replaced).toBe(true);
    expect(readIngestedCatalog()?.probedAt).toBe("2026-10-26T08:00:00.000Z");
  });

  it("caps model arrays to the hard limit", () => {
    const huge = {
      ...validPayload,
      models: Array.from({ length: 700 }, (_, i) => ({ id: `m${i}`, provider: "groq" })),
    };
    expect(validateIngestedCatalog(huge)?.models.length).toBe(500);
  });

  it("drops records without an id and survives mixed garbage entries", () => {
    const messy = {
      ...validPayload,
      models: [null, {}, { id: "" }, { id: "groq/deepseek-r1-distill", name: "R1" }, validPayload.models[0]],
    };
    const snap = validateIngestedCatalog(messy);
    expect(snap?.models.map((m) => m.id)).toEqual(["groq/deepseek-r1-distill", "openai/gpt-oss-120b"]);
  });

  it("fresherThan reflects the stored snapshot", () => {
    writeIngestedCatalog(validPayload);
    expect(ingestedIsFresherThan(Date.parse("2026-10-25T07:00:00.000Z"))).toBe(true);
    expect(ingestedIsFresherThan(Date.parse("2026-10-25T09:00:00.000Z"))).toBe(false);
    expect(ingestedIsFresherThan(Number.NaN)).toBe(false);
  });
});
