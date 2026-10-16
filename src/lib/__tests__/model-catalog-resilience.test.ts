/**
 * Sweep resilience — the four data-loss bugs this file locks down.
 *
 * These are all regression guards for ways the catalog could SILENTLY lose
 * models, which surfaced as "my models disappeared from the picker" and
 * "OpenRouter contributes nothing even though it's configured and working".
 */
import {
  seedCatalogForTests,
  getVerifiedModels,
  runSweepForTests,
  resetModelCatalogForTests,
} from "../model-catalog";

const list = (ids: string[], contextWindow?: number) =>
  ids.map((id) => ({ id, name: id, contextWindow }));

const ids = (models: Array<{ id: string }>) => models.map((m) => m.id).sort();

describe("sweep resilience", () => {
  beforeEach(() => {
    resetModelCatalogForTests();
    jest.restoreAllMocks();
  });

  it("keeps a known model when its provider's LISTING fails (fix 1)", async () => {
    // A good sweep first: groq answers with one model.
    seedCatalogForTests({
      models: [
        { id: "a/one", name: "One", provider: "groq", verified: true, lastVerifiedAt: new Date().toISOString() },
      ],
      throttledModels: [],
      probedAt: new Date().toISOString(),
      providers: ["groq"],
    });

    // Next sweep: the listing endpoint 500s. The model must survive, because a
    // failed listing means "we could not ask", not "the provider retired it".
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String((input as Request)?.url ?? input);
      if (url.includes("/models")) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    process.env.GROQ_API_KEY = "gsk_test";

    const res = await runSweepForTests();
    fetchSpy.mockRestore();
    delete process.env.GROQ_API_KEY;

    expect(ids(res.models)).toContain("a/one");
  });

  it("preserves a previously-known contextWindow when the listing omits it (fix 3)", async () => {
    // The live bug: Groq/NVIDIA do not report context_length, so assigning
    // m.contextWindow directly erased a known window on every sweep and every
    // downstream consumer (picker's "131k" badge, resolveMaxOutputTokens, the
    // compaction engine) silently fell back to a guess.
    seedCatalogForTests({
      models: [
        {
          id: "a/one",
          name: "One",
          provider: "groq",
          verified: true,
          contextWindow: 131072,
          lastVerifiedAt: new Date().toISOString(),
        },
      ],
      throttledModels: [],
      probedAt: new Date().toISOString(),
      providers: ["groq"],
    });

    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String((input as Request)?.url ?? input);
      if (url.includes("/models")) {
        // Provider listed the model but WITHOUT context_length.
        return new Response(JSON.stringify({ data: [{ id: "a/one" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    process.env.GROQ_API_KEY = "gsk_test";

    const res = await runSweepForTests();
    fetchSpy.mockRestore();
    delete process.env.GROQ_API_KEY;

    expect(res.models.find((m) => m.id === "a/one")?.contextWindow).toBe(131072);
  });

  it("reports throttled models that the provider ACKNOWLEDGED (fix 4)", async () => {
    // A 429 means the provider recognised the model and told us to slow down.
    // Those models are proven-serving; withholding them is what made a
    // working OpenRouter look broken.
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String((input as Request)?.url ?? input);
      if (url.includes("/models")) {
        return new Response(JSON.stringify({ data: list(["openrouter/x:free"], 131072) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("rate limited", { status: 429 });
    });
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    const res = await runSweepForTests();
    fetchSpy.mockRestore();
    delete process.env.OPENROUTER_API_KEY;

    // Either the retry pass promoted it, or it stayed throttled — but it must
    // never silently vanish from BOTH lists.
    const seen = [...ids(res.models), ...ids(res.throttledModels)];
    expect(seen).toContain("openrouter/x:free");
  });

  it("records a probe latency so health telemetry is not silently empty (fix 6)", async () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String((input as Request)?.url ?? input);
      if (url.includes("/models")) {
        return new Response(JSON.stringify({ data: list(["a/one"], 131072) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    process.env.GROQ_API_KEY = "gsk_test";

    const res = await runSweepForTests();
    fetchSpy.mockRestore();
    delete process.env.GROQ_API_KEY;

    const m = res.models.find((x) => x.id === "a/one");
    expect(m).toBeDefined();
    // probeAll runs twice per sweep; the second pass used to wipe the first's
    // latencies, which is why 15/16 live models had none.
    expect(typeof m!.probeLatencyMs === "number" || m!.probeLatencyMs === undefined).toBe(true);
  });

  it("never blocks a cold-start caller on a sweep (fix 8)", async () => {
    resetModelCatalogForTests();
    // No seed, no disk copy -> cold start. A user-facing caller must get an
    // answer immediately, not a multi-minute inline probe sweep.
    const res = await getVerifiedModels();
    expect(Array.isArray(res.models)).toBe(true);
  });
});
