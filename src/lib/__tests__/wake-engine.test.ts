// wake-engine.test.ts — The cold-start wake engine must be honest in every
// direction:
//   1. A cold model whose wake probe ANSWERS is promoted to verified (cold
//      flag dropped) — it then appears in getVerifiedModels.
//   2. A cold model whose probes TIME OUT through all attempts stays cold —
//      the picker keeps hiding it (stays in the catalog data, flagged cold).
//   3. A cold model that answers with a real HTTP error (404/400) under a
//      generous warm-up window is genuinely dead and is REMOVED from the
//      catalog entirely.
//   4. Progress states advance correctly (attempt counters, woke/failed/dead).
//
// The probe is injected (wakeColdModels({ probe })) — no network, no module
// mocking; the engine's real retry/spacing timers run at their real (short)
// intervals so the suite exercises the actual loop.

import {
  seedCatalogForTests,
  getCatalogForTests,
  resetWakeStateForTests,
  resetModelCatalogForTests,
  getWakeProgress,
  wakeColdModels,
  forceWakeColdModels,
  getVerifiedModels,
  isFreshlyVerified,
  modelHealth,
  FRESH_VERIFIED_MS,
  type CatalogResult,
  type CatalogModel,
  type WakeProbeFn,
} from "../model-catalog";

const VERDICT_OK = "ok" as const;
const VERDICT_TIMEOUT = "cold_start" as const;
const VERDICT_DEAD = "dead" as const;

function coldModel(id: string, provider = "nvidia"): CatalogModel {
  return {
    id,
    name: id,
    provider,
    verified: true,
    cold: true,
    contextWindow: 131072,
  };
}

function seed(models: CatalogModel[]): void {
  const data: CatalogResult = {
    models,
    throttledModels: [],
    probedAt: new Date().toISOString(),
    providers: ["nvidia"],
  };
  seedCatalogForTests(data);
}

/** Probe mock carrying per-verdict call history. impl receives (modelId, timeoutMs). */
function makeProbe(impl: (id: string, timeoutMs: number) => Promise<string>) {
  const fn = jest.fn(
    (_provider: string, modelId: string, _key: string, timeoutMs: number) => impl(modelId, timeoutMs)
  );
  return fn as unknown as { mock: { calls: Array<[string, string, string, number]> } } & WakeProbeFn;
}

/** Zero pacing: the engine's real 2–5s gaps would make the suite crawl. */
const FAST = { retryGapMs: 0, spacingMs: 0 };

beforeEach(() => {
  resetModelCatalogForTests();
  resetWakeStateForTests();
  // The engine reads the provider key from the environment — provide one so
  // the wake loop attempts probes (without it, models are skipped as
  // "failed" without probing).
  process.env.NVIDIA_API_KEY = "nvapi-test-key";
});

afterEach(async () => {
  // A timed-out test can leave a cycle running (its probe promise never
  // settled); drain it so the next test's resetWakeStateForTests isn't a
  // no-op against a still-in-flight gate.
  jest.runAllTimers();
  await Promise.resolve();
  await Promise.resolve();
});

afterEach(() => {
  delete process.env.NVIDIA_API_KEY;
});

describe("wake engine — promotion", () => {
  it("promotes a cold model to verified when a wake probe answers", async () => {
    seed([coldModel("nvidia/sleepy-model")]);
    const probe = makeProbe(() => Promise.resolve(VERDICT_OK));

    await wakeColdModels({ probe, ...FAST });

    const catalog = getCatalogForTests();
    expect(catalog).not.toBeNull();
    const m = catalog!.models.find((x) => x.id === "nvidia/sleepy-model");
    expect(m).toBeDefined();
    expect(m!.cold).toBeUndefined(); // flag dropped → picker will list it

    const progress = getWakeProgress();
    expect(progress.running).toBe(false);
    expect(progress.models[0].state).toBe("woke");
    expect(progress.models[0].attempt).toBe(1);
  });

  it("promotes through getVerifiedModels (picker contract)", async () => {
    seed([coldModel("nvidia/sleepy-model")]);
    await wakeColdModels({ probe: makeProbe(() => Promise.resolve(VERDICT_OK)), ...FAST });

    const { models } = await getVerifiedModels({ background: true });
    const listed = models.find((x) => x.id === "nvidia/sleepy-model");
    expect(listed).toBeDefined();
    expect((listed as { cold?: boolean }).cold).toBeUndefined();
  });

  it("keeps trying across attempts and promotes on a later attempt", async () => {
    seed([coldModel("nvidia/slow-warmup")]);
    // Attempts 1-2 time out (cold load), attempt 3 answers.
    let calls = 0;
    const probe = makeProbe(() => (++calls <= 2 ? Promise.resolve(VERDICT_TIMEOUT) : Promise.resolve(VERDICT_OK)));

    await wakeColdModels({ probe, ...FAST });

    const m = getCatalogForTests()!.models.find((x) => x.id === "nvidia/slow-warmup");
    expect(m).toBeDefined();
    expect(m!.cold).toBeUndefined();

    const progress = getWakeProgress();
    expect(progress.models[0].state).toBe("woke");
    expect(progress.models[0].attempt).toBe(3);
    expect(probe.mock.calls).toHaveLength(3);
    // Progressive warm-up windows: 120s → 90s → 60s.
    expect(probe.mock.calls[0][3]).toBe(120_000);
    expect(probe.mock.calls[1][3]).toBe(90_000);
    expect(probe.mock.calls[2][3]).toBe(60_000);
  });

  it("treats a post-warmup 429 as proof of life (rate_limited promotes)", async () => {
    seed([coldModel("nvidia/busy-but-alive")]);
    await wakeColdModels({ probe: makeProbe(() => Promise.resolve("rate_limited")), ...FAST });

    const m = getCatalogForTests()!.models.find((x) => x.id === "nvidia/busy-but-alive");
    expect(m).toBeDefined();
    expect(m!.cold).toBeUndefined();
  });
});

describe("wake engine — promotion notification", () => {
  it("notifies once per promoted model (durable bell, task-completed style)", async () => {
    seed([coldModel("nvidia/sleepy-model"), coldModel("nvidia/second-wind")]);
    const probe = makeProbe(() => Promise.resolve(VERDICT_OK));
    const onPromoted = jest.fn();

    await wakeColdModels({ probe, onPromoted, ...FAST });

    expect(onPromoted).toHaveBeenCalledTimes(2);
    expect(onPromoted).toHaveBeenCalledWith("nvidia/sleepy-model");
    expect(onPromoted).toHaveBeenCalledWith("nvidia/second-wind");
  });

  it("does not notify for models that never wake, go dead, or lack a key", async () => {
    seed([
      coldModel("nvidia/never-wakes"), // all attempts time out
      coldModel("nvidia/truly-dead"), // HTTP error → removed
      { ...coldModel("groq/keyless-cold"), provider: "groq" }, // no platform key
    ]);
    delete process.env.GROQ_API_KEY;
    const probe = makeProbe((id) =>
      id === "nvidia/truly-dead" ? Promise.resolve(VERDICT_DEAD) : Promise.resolve(VERDICT_TIMEOUT)
    );
    const onPromoted = jest.fn();

    await wakeColdModels({ probe, onPromoted, ...FAST });

    expect(onPromoted).not.toHaveBeenCalled();
    // Sanity: the three non-promotion outcomes actually happened.
    const states = Object.fromEntries(getWakeProgress().models.map((x) => [x.id, x.state]));
    expect(states["nvidia/never-wakes"]).toBe("failed");
    expect(states["nvidia/truly-dead"]).toBe("dead");
    expect(states["groq/keyless-cold"]).toBe("failed");
  });

  it("a throwing notification hook cannot break the wake cycle", async () => {
    seed([coldModel("nvidia/sleepy-model")]);
    const probe = makeProbe(() => Promise.resolve(VERDICT_OK));
    const onPromoted = jest.fn(() => {
      throw new Error("notification backend exploded");
    });

    await wakeColdModels({ probe, onPromoted, ...FAST });

    expect(onPromoted).toHaveBeenCalledWith("nvidia/sleepy-model");
    // The promotion itself still completed.
    const m = getCatalogForTests()!.models.find((x) => x.id === "nvidia/sleepy-model");
    expect(m).toBeDefined();
    expect(m!.cold).toBeUndefined();
    expect(getWakeProgress().models[0].state).toBe("woke");
  });
});

describe("wake engine — staying hidden", () => {
  it("keeps a model cold (hidden from the picker) when every probe times out", async () => {
    seed([coldModel("nvidia/never-wakes")]);
    const probe = makeProbe(() => Promise.resolve(VERDICT_TIMEOUT)); // timed out

    await wakeColdModels({ probe, ...FAST });

    const catalog = getCatalogForTests();
    const m = catalog!.models.find((x) => x.id === "nvidia/never-wakes");
    // Still catalogued — the provider lists it and it never 4xx'd — but the
    // cold flag keeps it out of the picker until a probe actually answers.
    expect(m).toBeDefined();
    expect(m!.cold).toBe(true);

    // And the picker endpoint's view: the model stays flagged cold.
    const { models } = await getVerifiedModels({ background: true });
    const listed = models.find((x) => x.id === "nvidia/never-wakes") as { cold?: boolean } | undefined;
    expect(listed?.cold).toBe(true);

    const progress = getWakeProgress();
    expect(progress.models[0].state).toBe("failed");
    expect(progress.models[0].attempt).toBe(3); // exhausted all attempts
    expect(probe.mock.calls).toHaveLength(3);
  });

  it("skips (marks failed) a cold model whose provider has no platform key", async () => {
    seed([{ ...coldModel("groq/keyless-cold"), provider: "groq" }]);
    delete process.env.GROQ_API_KEY; // registry def exists, no key
    const probe = makeProbe(() => Promise.resolve(VERDICT_OK));

    await wakeColdModels({ probe, ...FAST });

    const m = getCatalogForTests()!.models.find((x) => x.id === "groq/keyless-cold");
    expect(m).toBeDefined();
    expect(m!.cold).toBe(true); // untouched, still hidden
    expect(probe.mock.calls).toHaveLength(0);
    expect(getWakeProgress().models[0].state).toBe("failed");
  });
});

describe("wake engine — removing the genuinely dead", () => {
  it("removes a cold model from the catalog when it answers with an HTTP error", async () => {
    seed([
      coldModel("nvidia/gone-404"),
      coldModel("nvidia/still-cold"),
    ]);
    const probe = makeProbe((id) =>
      id === "nvidia/gone-404" ? Promise.resolve(VERDICT_DEAD) : Promise.resolve(VERDICT_TIMEOUT)
    );

    await wakeColdModels({ probe, ...FAST });

    const catalog = getCatalogForTests()!;
    // Dead-confirmed: REMOVED, not kept cold.
    expect(catalog.models.find((x) => x.id === "nvidia/gone-404")).toBeUndefined();
    // Its neighbour that only timed out is untouched.
    const stillCold = catalog.models.find((x) => x.id === "nvidia/still-cold");
    expect(stillCold).toBeDefined();
    expect(stillCold!.cold).toBe(true);

    const progress = getWakeProgress();
    expect(progress.models.find((x) => x.id === "nvidia/gone-404")!.state).toBe("dead");
    expect(progress.models.find((x) => x.id === "nvidia/still-cold")!.state).toBe("failed");
    // A dead verdict short-circuits the retry ladder — no wasted attempts.
    expect(probe.mock.calls.filter((c) => c[1] === "nvidia/gone-404")).toHaveLength(1);
  });
});

describe("wake engine — cycle behavior", () => {
  it("does nothing when the catalog has no cold models", async () => {
    seed([{ ...coldModel("nvidia/warm"), cold: undefined }]);
    const probe = makeProbe(() => Promise.resolve(VERDICT_OK));
    await wakeColdModels({ probe, ...FAST });
    expect(probe.mock.calls).toHaveLength(0);
    expect(getWakeProgress().models).toHaveLength(0);
  });

  it("collapses concurrent kicks into one cycle", async () => {
    seed([coldModel("nvidia/one")]);
    const probe = makeProbe(() => Promise.resolve(VERDICT_OK));

    const [a, b] = await Promise.all([wakeColdModels({ probe, ...FAST }), wakeColdModels({ probe, ...FAST })]);
    expect(a).toBe(b); // same in-flight promise
    expect(probe.mock.calls).toHaveLength(1);
  });


  it("respects the cooldown for a second cycle", async () => {
    seed([coldModel("nvidia/one")]);
    const probe = makeProbe(() => Promise.resolve(VERDICT_OK));

    await wakeColdModels({ probe, ...FAST });
    const callsAfterFirst = probe.mock.calls.length;
    await wakeColdModels({ probe, ...FAST }); // within cooldown → no-op
    expect(probe.mock.calls.length).toBe(callsAfterFirst);
  });

  it("forceWakeColdModels bypasses the cooldown", async () => {
    seed([coldModel("nvidia/one")]);
    const probe = makeProbe(() => Promise.resolve(VERDICT_OK));

    await wakeColdModels({ probe, ...FAST });
    const callsAfterFirst = probe.mock.calls.length;
    // Cycle one promoted the model (cold flag gone) — re-seed it cold so the
    // forced cycle has something to wake.
    seed([coldModel("nvidia/one")]);
    await forceWakeColdModels({ probe, ...FAST });
    expect(probe.mock.calls.length).toBe(callsAfterFirst + 1);
  });
});

describe("probe health tracking", () => {
  it("stamps lastVerifiedAt + latency when a wake probe promotes a model", async () => {
    seed([coldModel("nvidia/promoted")]);
    const probe = makeProbe(() => new Promise((r) => setTimeout(() => r(VERDICT_OK), 25)));

    await wakeColdModels({ probe, ...FAST });

    const m = getCatalogForTests()!.models.find((x) => x.id === "nvidia/promoted")!;
    expect(m.lastVerifiedAt).toBeDefined();
    const age = Date.now() - new Date(m.lastVerifiedAt!).getTime();
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(60_000);
    expect(m.probeLatencyMs).toBeGreaterThanOrEqual(20); // ~25ms sleep
    expect(modelHealth(m)).toBe("green");
  });

  it("health dot: green when verified <24h, amber when proof of life ages out", () => {
    const now = Date.now();
    const fresh: CatalogModel = { ...coldModel("nvidia/fresh"), cold: undefined, lastVerifiedAt: new Date(now - 3600_000).toISOString() };
    const stale: CatalogModel = { ...coldModel("nvidia/stale"), cold: undefined, lastVerifiedAt: new Date(now - FRESH_VERIFIED_MS - 60_000).toISOString() };
    const never: CatalogModel = { ...coldModel("nvidia/never"), cold: undefined };

    expect(modelHealth(fresh, now)).toBe("green");
    expect(modelHealth(stale, now)).toBe("amber");
    expect(modelHealth(never, now)).toBe("amber"); // no timestamp yet
    expect(isFreshlyVerified(fresh, now)).toBe(true);
    expect(isFreshlyVerified(stale, now)).toBe(false);
  });

  it("auto-sweep skips models verified <24h ago (fresh carry-forward)", async () => {
    // Hermetic end-to-end sweep: mock fetch so the NVIDIA listing returns
    // exactly our two models and every chat probe answers. The freshly
    // verified model must NOT be probed (no chat-completions call for it)
    // and its health rides forward; the cold one gets probed + stamped.
    const seededVerifiedAt = new Date(Date.now() - 3600_000).toISOString(); // 1h ago — fresh
    seed([
      { ...coldModel("nvidia/fresh-one"), cold: undefined, lastVerifiedAt: seededVerifiedAt, probeLatencyMs: 123 },
      coldModel("nvidia/cold-one"),
    ]);

    // Isolate from the host environment: only NVIDIA joins the sweep.
    const savedEnv = process.env.NVIDIA_API_KEY;
    for (const k of Object.keys(process.env)) {
      if (/_(API_KEY|KEY)$/.test(k) && !/NVIDIA/.test(k)) delete process.env[k];
    }

    const chatProbeIds: string[] = [];
    const originalFetch = global.fetch;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "nvidia/fresh-one" }, { id: "nvidia/cold-one" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/chat/completions")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        chatProbeIds.push(body.model ?? "");
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "hi" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const { runSweepForTests: sweep } = await import("../model-catalog");
      const result = await sweep(); // the real listing+probe sweep, hermetically

      // The fresh model was never probed.
      expect(chatProbeIds).not.toContain("nvidia/fresh-one");
      expect(chatProbeIds).toContain("nvidia/cold-one");

      // Its health carried forward EXACTLY (green, same timestamp + latency).
      const fresh = result.models.find((x) => x.id === "nvidia/fresh-one")!;
      expect(fresh.lastVerifiedAt).toBe(seededVerifiedAt);
      expect(fresh.probeLatencyMs).toBe(123);
      expect(modelHealth(fresh)).toBe("green");

      // The probed model got a NEW stamp (not the seeded one).
      const cold = result.models.find((x) => x.id === "nvidia/cold-one")!;
      expect(cold.lastVerifiedAt).toBeDefined();
      expect(cold.lastVerifiedAt).not.toBe(seededVerifiedAt);
      expect(cold.cold).toBeUndefined();
    } finally {
      global.fetch = originalFetch;
      process.env.NVIDIA_API_KEY = savedEnv;
    }
  }, 30000);

  it("wake skips cold models that are somehow freshly verified", async () => {
    // A cold model with a fresh lastVerifiedAt is contradictory state (e.g.
    // answer arrived, flag write raced); fresh proof of life wins — no wake.
    seed([{ ...coldModel("nvidia/paradox"), lastVerifiedAt: new Date().toISOString() }]);
    const probe = makeProbe(() => Promise.resolve(VERDICT_OK));

    await wakeColdModels({ probe, ...FAST });

    expect(probe.mock.calls).toHaveLength(0);
  });
});
