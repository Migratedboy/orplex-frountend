// provenance-flags.test.ts + provenance.test.ts — Phase 4: the provenance
// ledger and the appended flags. Everything here is pure logic: no I/O, no
// worker, no network.

import {
  MOST_DANGEROUS,
  PROVENANCE_DANGEROUSNESS,
  Provenance,
  TaintStore,
  mostDangerous,
} from "../reliability/provenance";
import {
  reliabilityCapabilityPolicyEnabled,
  reliabilityInjectionScanEnabled,
  reliabilityProvenanceEnabled,
  reliabilityScrubbingEnabled,
} from "../reliability/flags";

const KEYS_ENV = process.env;

afterEach(() => {
  process.env = KEYS_ENV;
});

const ALL_PROVENANCES: Provenance[] = [
  "user",
  "native",
  "read_file",
  "tool_output",
  "prose_tool",
  "bare_json",
  "orchestrator",
  "directive",
  "repair",
];

describe("provenance ladder", () => {
  it("orders user lowest and repair highest", () => {
    expect(PROVENANCE_DANGEROUSNESS[0]).toBe("user");
    expect(MOST_DANGEROUS).toBe("repair");
    expect(PROVENANCE_DANGEROUSNESS).toHaveLength(ALL_PROVENANCES.length);
  });

  it("mostDangerous picks the highest-ranked of a set, regardless of order", () => {
    expect(mostDangerous(["user", "prose_tool", "native"])).toBe("prose_tool");
    expect(mostDangerous(["repair", "directive"])).toBe("repair");
    expect(mostDangerous([])).toBeNull();
  });
});

describe("TaintStore", () => {
  it("mark/get/isTainted round-trips a single mark", () => {
    const taint = new TaintStore();
    expect(taint.get("src/billing.ts")).toBeNull();
    expect(taint.isTainted("src/billing.ts")).toBe(false);
    taint.mark("src/billing.ts", "read_file");
    expect(taint.get("src/billing.ts")).toBe("read_file");
    expect(taint.isTainted("src/billing.ts")).toBe(true);
  });

  it("never de-taints: a later less-dangerous mark keeps the worse label", () => {
    const taint = new TaintStore();
    taint.mark("p", "directive");
    taint.mark("p", "user");
    expect(taint.get("p")).toBe("directive");
  });

  it("propagate inherits the MOST-DANGEROUS of the sources", () => {
    const taint = new TaintStore();
    taint.mark("summary", "tool_output");
    taint.mark("comment", "bare_json");
    taint.propagate("derived", ["summary", "comment"]);
    expect(taint.get("derived")).toBe("bare_json");
  });

  it("propagate ignores unknown sources and leaves dest unrecorded when none are tainted", () => {
    const taint = new TaintStore();
    taint.mark("user_text", "user");
    expect(taint.propagate("derived", ["user_text", "never_marked"])).toBe("user");
    expect(taint.get("derived")).toBe("user");
    expect(taint.propagate("derived2", ["never_marked"])).toBeNull();
    expect(taint.get("derived2")).toBeNull();
  });

  it("propagate does not lower an existing more-dangerous dest label", () => {
    const taint = new TaintStore();
    taint.mark("src", "user");
    taint.mark("dest", "directive");
    taint.propagate("dest", ["src"]);
    expect(taint.get("dest")).toBe("directive");
  });

  it("isTainted is false for user provenance but true for every other origin", () => {
    const taint = new TaintStore();
    for (const prov of ALL_PROVENANCES) {
      taint.clear();
      taint.mark(`key:${prov}`, prov);
      expect(taint.isTainted(`key:${prov}`)).toBe(prov !== "user");
    }
  });

  it("clear() empties everything", () => {
    const taint = new TaintStore();
    taint.mark("a", "repair");
    taint.clear();
    expect(taint.get("a")).toBeNull();
    expect(taint.toJSON()).toEqual({});
  });

  it("toJSON / fromJSON round-trips through an object and a string", () => {
    const taint = new TaintStore();
    taint.mark("readme.md", "read_file");
    taint.mark("cmd", "directive");
    const json = taint.toJSON();
    expect(json).toEqual({ "readme.md": "read_file", cmd: "directive" });
    expect(TaintStore.fromJSON(json).toJSON()).toEqual(json);
    expect(TaintStore.fromJSON(JSON.stringify(json)).toJSON()).toEqual(json);
  });

  it("fromJSON drops unknown provenance strings instead of guessing", () => {
    const taint = TaintStore.fromJSON(JSON.stringify({ a: "not-a-provenance", b: "user" }));
    expect(taint.get("a")).toBeNull();
    expect(taint.get("b")).toBe("user");
  });

  it("fromJSON tolerates garbage input", () => {
    expect(TaintStore.fromJSON(null).toJSON()).toEqual({});
    expect(TaintStore.fromJSON("not json").toJSON()).toEqual({});
    expect(TaintStore.fromJSON([1, 2] as unknown as Record<string, Provenance>).toJSON()).toEqual({});
  });
});

describe("appended Phase 4 flags (defaults OFF)", () => {
  const flags: Record<string, () => boolean> = {
    RELIABILITY_TAINT: reliabilityProvenanceEnabled,
    RELIABILITY_INJECTION_SCAN: reliabilityInjectionScanEnabled,
    RELIABILITY_SCRUB: reliabilityScrubbingEnabled,
    RELIABILITY_CAPABILITY_POLICY: reliabilityCapabilityPolicyEnabled,
  };

  it.each([
    ["RELIABILITY_TAINT", reliabilityProvenanceEnabled],
    ["RELIABILITY_INJECTION_SCAN", reliabilityInjectionScanEnabled],
    ["RELIABILITY_SCRUB", reliabilityScrubbingEnabled],
    ["RELIABILITY_CAPABILITY_POLICY", reliabilityCapabilityPolicyEnabled],
  ])("%s is off with nothing set", (_name, fn) => {
    delete process.env.RELIABILITY_GATES;
    delete process.env[_name];
    expect(fn()).toBe(false);
  });

  it.each([
    ["RELIABILITY_TAINT", reliabilityProvenanceEnabled],
    ["RELIABILITY_INJECTION_SCAN", reliabilityInjectionScanEnabled],
    ["RELIABILITY_SCRUB", reliabilityScrubbingEnabled],
    ["RELIABILITY_CAPABILITY_POLICY", reliabilityCapabilityPolicyEnabled],
  ])("%s needs the master switch AND its own =1", (_name, fn) => {
    process.env.RELIABILITY_GATES = "1";
    delete process.env[_name];
    expect(fn()).toBe(false);
    process.env[_name] = "1";
    delete process.env.RELIABILITY_GATES;
    expect(fn()).toBe(false);
    process.env.RELIABILITY_GATES = "1";
    expect(fn()).toBe(true);
  });

  it("every appended flag consumes only its own RELIABILITY_* name", () => {
    for (const [name, fn] of Object.entries(flags)) {
      process.env.RELIABILITY_GATES = "1";
      process.env[name] = "1";
      expect(fn()).toBe(true);
      process.env[name] = "0";
      expect(fn()).toBe(false);
      delete process.env[name];
    }
  });
});
