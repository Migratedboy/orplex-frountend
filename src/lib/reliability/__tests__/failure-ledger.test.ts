// failure-ledger.test.ts — Phase 6: the durable, evidence-only failure
// ledger. Storage is injected (MemoryLedgerStorage), so everything runs
// without a database: signatures (reusing gates.ts's extractor), record /
// listUnresolved / markResolved semantics, and the hydration helpers that
// seed failure-memory.ts's in-memory store — including the flag gate that
// keeps model-facing seeding OFF by default.

import {
  FailureLedger,
  MemoryLedgerStorage,
  createLedgerEntry,
  laneToFailureKind,
  ledgerSignature,
  seedFailureMemory,
  toFailureRecord,
  type LedgerEntry,
  type LedgerStorage,
} from "../failure-ledger";
import { getFailures, resetFailureMemory } from "../../failure-memory";
import { reliabilityDurableMemoryEnabled } from "../flags";

const ENV = process.env;

beforeEach(() => {
  process.env = { ...ENV };
  delete process.env.RELIABILITY_GATES;
  delete process.env.RELIABILITY_DURABLE_MEMORY;
  resetFailureMemory();
});

afterAll(() => {
  process.env = ENV;
});

function armFlag() {
  process.env.RELIABILITY_GATES = "1";
  process.env.RELIABILITY_DURABLE_MEMORY = "1";
}

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  const base = createLedgerEntry({
    workspaceKey: "orplex-local:demo",
    lane: "typecheck",
    evidence: "src/a.ts(10,5): error TS2345: Argument of type 'x' is not assignable.",
    files: ["src/a.ts"],
    at: "2026-10-17T10:00:00.000Z",
  });
  if (!base) throw new Error("fixture entry failed to build");
  const merged = { ...base, ...over };
  // Overridden evidence/lane/files change a failure's identity, so recompute
  // the signature the way createLedgerEntry would for the same raw inputs —
  // an override must not silently inherit the base fixture's signature.
  if (over.evidence !== undefined || over.lane !== undefined || over.files !== undefined) {
    merged.signature = ledgerSignature(merged.lane, merged.evidence, merged.files);
  }
  return merged;
}

describe("flag default (Phase 6 ships OFF)", () => {
  it("reliabilityDurableMemoryEnabled is false with no env set", () => {
    expect(reliabilityDurableMemoryEnabled()).toBe(false);
  });

  it("requires the master switch as well as its own env var", () => {
    process.env.RELIABILITY_DURABLE_MEMORY = "1";
    expect(reliabilityDurableMemoryEnabled()).toBe(false);
    process.env.RELIABILITY_GATES = "1";
    expect(reliabilityDurableMemoryEnabled()).toBe(true);
  });
});

describe("ledgerSignature — normalized error code + file, gates.ts format", () => {
  it("reuses the gates.ts extractor for tsc evidence (path:CODE)", () => {
    expect(
      ledgerSignature(
        "typecheck",
        "src/a.ts(10,5): error TS2345: Argument of type 'x'.\nsrc/b.ts(1,1): error TS1005: ';' expected.",
        []
      )
    ).toBe("src/a.ts:TS2345"); // extractor output is sorted → deterministic
  });

  it("falls back to file:CODE for non-tsc evidence", () => {
    expect(ledgerSignature("command", "Error: listen EADDRINUSE: address already in use :::3001", [])).toBe(
      "(no-file):EADDRINUSE"
    );
    expect(
      ledgerSignature("browser", "GET /api/x failed: HTTP 404", ["src\\pages\\api\\x.ts"])
    ).toBe("src/pages/api/x.ts:HTTP 404");
  });

  it("degrades to (no-file):UNKNOWN rather than throwing", () => {
    expect(ledgerSignature("review", "something went wrong", [])).toBe("(no-file):UNKNOWN");
    expect(ledgerSignature("review", "", [])).toBe("(no-file):UNKNOWN");
  });
});

describe("createLedgerEntry / toFailureRecord — evidence in, records out", () => {
  it("builds a well-formed entry and computes the signature itself", () => {
    const e = createLedgerEntry({
      workspaceKey: "ws",
      lane: "typecheck",
      evidence: "src/z.ts(1,1): error TS1005: ';' expected.",
      files: ["src/z.ts"],
    });
    expect(e).not.toBeNull();
    expect(e!.workspaceKey).toBe("ws");
    expect(e!.signature).toBe("src/z.ts:TS1005");
    expect(e!.recurrence).toBe(1);
    expect(e!.resolved).toBe(false);
    expect(Number.isFinite(Date.parse(e!.at))).toBe(true);
    expect(e!.id).toBeTruthy();
  });

  it("rejects entries with no evidence — the ledger is evidence-only", () => {
    expect(createLedgerEntry({ workspaceKey: "ws", lane: "typecheck", evidence: "   " })).toBeNull();
    expect(createLedgerEntry({ workspaceKey: "", lane: "typecheck", evidence: "e" })).toBeNull();
    expect(createLedgerEntry({ workspaceKey: "ws", lane: "", evidence: "e" })).toBeNull();
  });

  it("maps lanes onto failure-memory kinds and drops unknown lanes", () => {
    expect(laneToFailureKind("typecheck")).toBe("typecheck");
    expect(laneToFailureKind("lint")).toBe("typecheck");
    expect(laneToFailureKind("swarm")).toBe("review");
    expect(laneToFailureKind("test")).toBe("command");
    expect(laneToFailureKind("bogus")).toBeNull();
    expect(toFailureRecord(entry({ lane: "bogus" }))).toBeNull();
    const rec = toFailureRecord(entry({ lane: "swarm", recurrence: 3 }));
    expect(rec?.kind).toBe("review");
    expect(rec?.count).toBe(3);
    expect(rec?.detail).toContain("TS2345");
    expect(toFailureRecord(entry({ lane: "swarm", at: "not-a-date" }))?.when).toBeGreaterThan(0);
  });
});

describe("FailureLedger over injected storage — no database required", () => {
  it("records, lists unresolved newest-first, and resolves by signature", async () => {
    const storage = new MemoryLedgerStorage();
    const ledger = new FailureLedger(storage, "orplex-local:demo");

    expect(await ledger.record(entry({ id: "e1", at: "2026-10-17T10:00:00.000Z" }))).toBe(true);
    expect(
      await ledger.record(
        entry({
          id: "e2",
          lane: "command",
          evidence: "Error: listen EADDRINUSE :::3001",
          files: [],
          at: "2026-10-17T11:00:00.000Z",
        })
      )
    ).toBe(true);

    const open = await ledger.listUnresolved("orplex-local:demo");
    expect(open.map((e) => e.id)).toEqual(["e2", "e1"]); // newest first
    expect(open).toHaveLength(2);

    await ledger.markResolved([open[0].signature]); // default workspace scope
    const after = await ledger.listUnresolved("orplex-local:demo");
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe("e1");
    expect((await ledger.listUnresolved("other-ws"))).toHaveLength(0);
  });

  it("refuses to record without evidence and survives a throwing storage", async () => {
    const storage = new MemoryLedgerStorage();
    const ledger = new FailureLedger(storage);
    expect(await ledger.record(entry({ evidence: "" }))).toBe(false);
    expect(storage.all()).toHaveLength(0); // the empty-evidence entry never landed

    const broken: LedgerStorage = {
      append: async () => {
        throw new Error("db down");
      },
      list: async () => {
        throw new Error("db down");
      },
      resolveSignatures: async () => {
        throw new Error("db down");
      },
    };
    const ledger2 = new FailureLedger(broken, "ws");
    expect(await ledger2.record(entry())).toBe(false); // {ok:false}, never a throw
    expect(await ledger2.listUnresolved("ws")).toEqual([]);
    await expect(ledger2.markResolved(["sig"])).resolves.toBeUndefined();
  });

  it("defensively normalizes entries read back from storage", async () => {
    const storage = new MemoryLedgerStorage();
    await storage.append({
      id: "",
      workspaceKey: "ws",
      at: "garbage",
      lane: "typecheck",
      signature: "src/a.ts:TS1",
      evidence: "src/a.ts(1,1): error TS1: bad",
      files: ["src/a.ts", 42 as unknown as string],
      recurrence: 0,
      resolved: false,
    });
    const ledger = new FailureLedger(storage);
    const [e] = await ledger.listUnresolved("ws");
    expect(e.id).toBeTruthy();
    expect(Number.isFinite(Date.parse(e.at))).toBe(true);
    expect(e.recurrence).toBe(1);
    expect(e.files).toEqual(["src/a.ts"]); // non-string dropped
  });
});

describe("hydration helpers — seeding failure-memory from the ledger", () => {
  it("seedFailureMemory merges entries into the in-memory doctrine", () => {
    const n = seedFailureMemory([
      entry({ lane: "typecheck", recurrence: 4, at: "2026-10-17T09:00:00.000Z" }),
      entry({ id: "b", lane: "bogus", evidence: "unmapped lane" }), // dropped
    ]);
    expect(n).toBe(1);
    const failures = getFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0].kind).toBe("typecheck");
    expect(failures[0].count).toBe(4);
  });

  it("hydrateFailureMemory seeds ONLY when the durable-memory flag is armed", async () => {
    const storage = new MemoryLedgerStorage();
    const ledger = new FailureLedger(storage);
    await ledger.record(entry({ recurrence: 2 }));

    // Default OFF: no seeding, no crash.
    expect(await ledger.hydrateFailureMemory("orplex-local:demo")).toBe(0);
    expect(getFailures()).toHaveLength(0);

    // Armed: the same call seeds the doctrine with recurrence preserved.
    armFlag();
    expect(await ledger.hydrateFailureMemory("orplex-local:demo")).toBe(1);
    expect(getFailures()[0].count).toBe(2);
  });

  it("returns 0 for an unknown workspace instead of throwing", async () => {
    armFlag();
    const ledger = new FailureLedger(new MemoryLedgerStorage());
    expect(await ledger.hydrateFailureMemory("never-seen")).toBe(0);
  });
});
