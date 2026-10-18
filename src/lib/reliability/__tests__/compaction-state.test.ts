// compaction-state.test.ts — Phase 6: persistable compaction state so a
// reload resumes incrementally instead of re-summarizing the whole prefix.
// Covers serialize/deserialize (null on corrupt), the injected KV store +
// its memory double, the flag gate that keeps NEW persistence OFF by default,
// the compaction.ts interop converters, and the recall_event design seam.

import {
  CompactionStateStore,
  MemoryCompactionStateStore,
  buildRecallEvent,
  buildRecallKey,
  deserializeCompactionState,
  fromCompactionStateV2,
  serializeCompactionState,
  toCompactionStateV2,
  type CompactionStateStorage,
  type CompactionStateV2,
} from "../compaction-state";
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

const STATE: CompactionStateV2 = {
  coveredCount: 7,
  summary: "User asked for a settings page; files touched: app/settings/page.tsx.",
  fingerprint: "123,456,789,101,112,131,141",
  updatedAt: 1_760_000_000_000,
};

describe("serializeCompactionState / deserializeCompactionState", () => {
  it("round-trips a valid state", () => {
    const back = deserializeCompactionState(serializeCompactionState(STATE));
    expect(back).toEqual(STATE);
  });

  it("accepts an empty fingerprint (nothing covered yet)", () => {
    const back = deserializeCompactionState(serializeCompactionState({ ...STATE, fingerprint: "" }));
    expect(back?.fingerprint).toBe("");
    expect(back?.coveredCount).toBe(7);
  });

  it("returns null on corrupt input instead of throwing", () => {
    expect(deserializeCompactionState("{not json")).toBeNull();
    expect(deserializeCompactionState("null")).toBeNull();
    expect(deserializeCompactionState('["array"]')).toBeNull();
    expect(deserializeCompactionState("")).toBeNull();
    expect(deserializeCompactionState(null)).toBeNull();
    expect(deserializeCompactionState(undefined)).toBeNull();
  });

  it("returns null on wrong field types", () => {
    expect(deserializeCompactionState(JSON.stringify({ ...STATE, coveredCount: "7" }))).toBeNull();
    expect(deserializeCompactionState(JSON.stringify({ ...STATE, summary: 7 }))).toBeNull();
    expect(deserializeCompactionState(JSON.stringify({ ...STATE, fingerprint: 7 }))).toBeNull();
    expect(deserializeCompactionState(JSON.stringify({ ...STATE, updatedAt: "now" }))).toBeNull();
  });

  it("returns null on out-of-range or non-integer counters", () => {
    expect(deserializeCompactionState(JSON.stringify({ ...STATE, coveredCount: -1 }))).toBeNull();
    expect(deserializeCompactionState(JSON.stringify({ ...STATE, coveredCount: 1.5 }))).toBeNull();
    expect(deserializeCompactionState(JSON.stringify({ ...STATE, updatedAt: -5 }))).toBeNull();
    expect(deserializeCompactionState(JSON.stringify({ ...STATE, fingerprint: "12,-3,4" }))).toBeNull();
    expect(deserializeCompactionState(JSON.stringify({ ...STATE, fingerprint: "12,abc" }))).toBeNull();
  });

  it("returns null when the fingerprint length disagrees with coveredCount is a caller concern, not a parse error", () => {
    // Parsing only validates the SHAPE; fromCompactionStateV2 enforces the
    // coveredCount/fingerprint agreement that the incremental check needs.
    const parsed = deserializeCompactionState(JSON.stringify({ ...STATE, fingerprint: "123,456" }));
    expect(parsed).not.toBeNull();
    expect(fromCompactionStateV2(parsed)).toBeNull();
  });
});

describe("CompactionStateStore — injected KV storage", () => {
  function kv(): CompactionStateStorage & { raw: Map<string, string> } {
    const raw = new Map<string, string>();
    return {
      raw,
      read: async (key) => raw.get(key) ?? null,
      write: async (key, value) => {
        raw.set(key, value);
      },
    };
  }

  it("save/load round-trips when the durable-memory flag is armed", async () => {
    armFlag();
    const storage = kv();
    const store = new CompactionStateStore(storage);
    expect(await store.save("compaction:task-1", STATE)).toBe(true);
    expect(await store.load("compaction:task-1")).toEqual(STATE);
    expect(storage.raw.get("compaction:task-1")).toBe(serializeCompactionState(STATE));
  });

  it("save is inert (returns false, writes nothing) while the flag is OFF", async () => {
    const storage = kv();
    const store = new CompactionStateStore(storage);
    expect(await store.save("compaction:task-1", STATE)).toBe(false);
    expect(storage.raw.size).toBe(0);
    expect(reliabilityDurableMemoryEnabled()).toBe(false);
  });

  it("load still recovers a previously-armed state while the flag is off", async () => {
    const storage = kv();
    storage.raw.set("k", serializeCompactionState(STATE));
    const store = new CompactionStateStore(storage);
    expect(await store.load("k")).toEqual(STATE);
    expect(await store.load("never-written")).toBeNull();
  });

  it("a throwing storage degrades to false / null, never a throw", async () => {
    const broken: CompactionStateStorage = {
      read: async () => {
        throw new Error("db down");
      },
      write: async () => {
        throw new Error("db down");
      },
    };
    const store = new CompactionStateStore(broken);
    armFlag();
    expect(await store.save("k", STATE)).toBe(false);
    expect(await store.load("k")).toBeNull();
  });

  it("rejects empty keys", async () => {
    armFlag();
    const store = new CompactionStateStore(kv());
    expect(await store.save("", STATE)).toBe(false);
    expect(await store.load("")).toBeNull();
  });
});

describe("MemoryCompactionStateStore — same contract, no persistence", () => {
  it("round-trips under the flag and stays empty without it", async () => {
    const store = new MemoryCompactionStateStore();
    expect(await store.save("k", STATE)).toBe(false); // default OFF
    expect(store.has("k")).toBe(false);
    armFlag();
    expect(await store.save("k", STATE)).toBe(true);
    expect(store.has("k")).toBe(true);
    expect(await store.load("k")).toEqual(STATE);
    expect(await store.load("missing")).toBeNull();
  });
});

describe("compaction.ts interop — V2 ↔ CompactionState", () => {
  it("round-trips live compactor state through V2", () => {
    const live = { coveredCount: 3, summary: "s", fingerprint: [1, 2, 4294967295] };
    const v2 = toCompactionStateV2(live, 99);
    expect(v2).toEqual({ coveredCount: 3, summary: "s", fingerprint: "1,2,4294967295", updatedAt: 99 });
    expect(fromCompactionStateV2(v2)).toEqual(live);
  });

  it("refuses a fingerprint whose length disagrees with coveredCount", () => {
    const live = { coveredCount: 3, summary: "s", fingerprint: [1, 2] };
    expect(fromCompactionStateV2(toCompactionStateV2(live))).toBeNull();
    expect(fromCompactionStateV2(null)).toBeNull();
  });
});

describe("recall_event — design seam for recovering compacted raw output", () => {
  it("buildRecallKey is stable and index-based", () => {
    expect(buildRecallKey(5, "abc")).toBe("recall:5:abc");
    // Same message, later compaction → same key.
    expect(buildRecallKey(5, "abc")).toBe(buildRecallKey(5, "abc"));
    // Pathological inputs still produce a usable key (never NaN).
    expect(buildRecallKey(-3, "abc")).toBe("recall:0:abc");
    expect(buildRecallKey(Number.NaN, "abc")).toBe("recall:0:abc");
    expect(buildRecallKey(5.9, "abc")).toBe("recall:5:abc");
  });

  it("buildRecallEvent carries { key, rawPrefix, at }", () => {
    const e = buildRecallEvent(5, "abc", "raw tool output that compaction dropped", 123);
    expect(e).toEqual({
      key: "recall:5:abc",
      rawPrefix: "raw tool output that compaction dropped",
      at: 123,
    });
  });
});
