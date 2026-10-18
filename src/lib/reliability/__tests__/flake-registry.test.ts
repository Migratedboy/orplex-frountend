// flake-registry.test.ts — Phase 6: the durable flake registry. Storage is
// injected (MemoryFlakeStorage), so everything runs without a database:
// counter accumulation across registry instances (restart survival), the
// quarantine rule mirrored from flake-control.ts, the flag gate that keeps
// quarantine (gate-affecting behaviour) OFF by default, and the JSON
// snapshot round-trip.

import {
  DurableFlakeRegistry,
  MemoryFlakeStorage,
  durableFlakeEntryFrom,
  flakeKey,
  normalizeFlakeEntry,
  type FlakeEntry,
} from "../flake-registry";
import { reliabilityDurableMemoryEnabled } from "../flags";

const ENV = process.env;

beforeEach(() => {
  process.env = { ...ENV };
  delete process.env.RELIABILITY_GATES;
  delete process.env.RELIABILITY_DURABLE_MEMORY;
});

afterAll(() => {
  process.env = ENV;
});

function armFlag() {
  process.env.RELIABILITY_GATES = "1";
  process.env.RELIABILITY_DURABLE_MEMORY = "1";
}

const PATH = "src/lib/__tests__/example.test.ts";
const NAME = "does the thing";

describe("MemoryFlakeStorage — the injected test double", () => {
  it("get/set/list round-trip with defensive copies", async () => {
    const storage = new MemoryFlakeStorage();
    const entry: FlakeEntry = {
      testPath: PATH,
      testName: NAME,
      failures: 1,
      passes: 0,
      firstSeen: 1,
      lastSeen: 2,
      quarantined: false,
    };
    await storage.set(flakeKey(PATH, NAME), entry);
    entry.failures = 99; // caller mutation must not leak into storage
    const back = await storage.get(flakeKey(PATH, NAME));
    expect(back?.failures).toBe(1);
    const listed = await storage.list();
    expect(listed).toHaveLength(1);
    expect(await storage.get("missing")).toBeNull();
  });
});

describe("DurableFlakeRegistry — counters survive a restart", () => {
  it("accumulates outcomes and computes quarantine (fail-then-pass)", async () => {
    const storage = new MemoryFlakeStorage();
    const registry = new DurableFlakeRegistry(storage, { now: () => 1000 });

    const first = await registry.recordOutcome(PATH, NAME, false);
    expect(first).toMatchObject({ failures: 1, passes: 0, quarantined: false, firstSeen: 1000, lastSeen: 1000 });

    const second = await registry.recordOutcome(PATH, NAME, true);
    expect(second).toMatchObject({ failures: 1, passes: 1, quarantined: true });

    // A second registry over the same storage = a restart: state is durable.
    const restarted = new DurableFlakeRegistry(storage);
    const stored = await restarted.get(PATH, NAME);
    expect(stored).toMatchObject({ failures: 1, passes: 1, quarantined: true });
    expect(storage.size()).toBe(1); // one key, not two
  });

  it("keeps counters per (testPath, testName), not per path", async () => {
    const registry = new DurableFlakeRegistry(new MemoryFlakeStorage());
    await registry.recordOutcome(PATH, "test A", false);
    await registry.recordOutcome(PATH, "test B", true);
    expect((await registry.get(PATH, "test A"))).toMatchObject({ failures: 1, passes: 0 });
    expect((await registry.get(PATH, "test B"))).toMatchObject({ failures: 0, passes: 1 });
    expect(await registry.get("other/path", "test A")).toBeNull();
  });

  it("never throws on a broken storage — the in-memory answer still holds", async () => {
    const broken = {
      get: async (): Promise<FlakeEntry | null> => {
        throw new Error("db down");
      },
      set: async (): Promise<void> => {
        throw new Error("db down");
      },
      list: async (): Promise<FlakeEntry[]> => {
        throw new Error("db down");
      },
    };
    const registry = new DurableFlakeRegistry(broken);
    const e = await registry.recordOutcome(PATH, NAME, false);
    expect(e?.failures).toBe(1);
    expect(await registry.get(PATH, NAME)).toMatchObject({ failures: 1 });
  });

  it("rejects empty keys instead of storing junk", async () => {
    const registry = new DurableFlakeRegistry(new MemoryFlakeStorage());
    expect(await registry.recordOutcome("", NAME, false)).toBeNull();
    expect(await registry.recordOutcome(PATH, "", false)).toBeNull();
    expect((await registry.toJSON()).entries).toHaveLength(0);
  });
});

describe("isQuarantined — gate-affecting behaviour defaults OFF", () => {
  async function registryWithUnstableTest(): Promise<DurableFlakeRegistry> {
    const registry = new DurableFlakeRegistry(new MemoryFlakeStorage());
    await registry.recordOutcome(PATH, NAME, false);
    await registry.recordOutcome(PATH, NAME, true);
    return registry;
  }

  it("returns false while the durable-memory flag is off", async () => {
    const registry = await registryWithUnstableTest();
    expect(reliabilityDurableMemoryEnabled()).toBe(false);
    expect(await registry.isQuarantined(PATH, NAME)).toBe(false);
    expect(await registry.isQuarantined(PATH)).toBe(false);
  });

  it("returns true for the same unstable test once the flag is armed", async () => {
    const registry = await registryWithUnstableTest();
    armFlag();
    expect(await registry.isQuarantined(PATH, NAME)).toBe(true);
  });

  it("with no testName, any quarantined test under the path counts", async () => {
    const registry = new DurableFlakeRegistry(new MemoryFlakeStorage());
    await registry.recordOutcome(PATH, "stable only", false); // never passed → not flaky
    armFlag();
    expect(await registry.isQuarantined(PATH)).toBe(false);
    await registry.recordOutcome(PATH, "stable only", true); // now fail-then-pass
    expect(await registry.isQuarantined(PATH)).toBe(true);
  });

  it("is false for a test that only ever failed (a real regression, not a flake)", async () => {
    const registry = new DurableFlakeRegistry(new MemoryFlakeStorage());
    await registry.recordOutcome(PATH, NAME, false);
    armFlag();
    expect(await registry.isQuarantined(PATH, NAME)).toBe(false);
  });
});

describe("toJSON / fromJSON — snapshot round-trip", () => {
  it("round-trips entries through a JSON string into fresh storage", async () => {
    const source = new DurableFlakeRegistry(new MemoryFlakeStorage());
    await source.recordOutcome(PATH, NAME, false);
    await source.recordOutcome(PATH, NAME, true);

    const json = JSON.stringify(await source.toJSON());
    const targetStorage = new MemoryFlakeStorage();
    const restored = await DurableFlakeRegistry.fromJSON(json, targetStorage);

    armFlag();
    expect(await restored.isQuarantined(PATH, NAME)).toBe(true);
    // The import wrote through to storage, so the NEXT restart is durable too.
    expect(targetStorage.size()).toBe(1);
    expect(await targetStorage.get(flakeKey(PATH, NAME))).toMatchObject({ failures: 1, passes: 1 });
  });

  it("never throws on corrupt JSON — an empty registry is returned", async () => {
    const storage = new MemoryFlakeStorage();
    const restored = await DurableFlakeRegistry.fromJSON("{not json", storage);
    expect((await restored.toJSON()).entries).toEqual([]);
    const notAnObject = await DurableFlakeRegistry.fromJSON('["a"]', storage);
    expect((await notAnObject.toJSON()).entries).toEqual([]);
  });
});

describe("flake-control interop + normalization", () => {
  it("durableFlakeEntryFrom adapts flake-control's {at} entry shape", () => {
    const durable = durableFlakeEntryFrom({
      testPath: PATH,
      testName: NAME,
      failures: 1,
      passes: 1,
      at: 4242,
    });
    expect(durable).toEqual({
      testPath: PATH,
      testName: NAME,
      failures: 1,
      passes: 1,
      firstSeen: 4242,
      lastSeen: 4242,
      quarantined: true,
    });
  });

  it("normalizeFlakeEntry recomputes quarantine from the counters", () => {
    expect(
      normalizeFlakeEntry({ testPath: PATH, testName: NAME, failures: 2, passes: 3, firstSeen: 1, lastSeen: 2, quarantined: true })
    ).toMatchObject({ quarantined: true });
    // A stored `quarantined: true` with no passing evidence is NOT trusted.
    expect(
      normalizeFlakeEntry({ testPath: PATH, testName: NAME, failures: 1, passes: 0, firstSeen: 1, lastSeen: 2, quarantined: true })?.quarantined
    ).toBe(false);
    expect(normalizeFlakeEntry({ testPath: "", testName: NAME })).toBeNull();
    expect(normalizeFlakeEntry(null)).toBeNull();
  });
});
