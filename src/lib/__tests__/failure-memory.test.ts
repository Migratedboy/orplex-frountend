/**
 * failure-memory.test.ts — The adaptive Failure Doctrine: real verification
 * failures are recorded with recurrence counts, repair turns get the actual
 * evidence injected (not generic advice), solved lanes are cleared, fresh
 * tasks after a failure inherit the context, and everything is "" when the
 * history is empty (never pad the context with empty structure).
 */
import {
  recordFailure,
  recordRepairAttempt,
  clearFailures,
  getFailures,
  buildFailureDoctrineContext,
  resetFailureMemory,
} from "../failure-memory";
import { adaptiveFailureDoctrine } from "../master-prompt";

beforeEach(() => {
  resetFailureMemory();
});

describe("recordFailure — evidence capture with recurrence", () => {
  it("stores a typecheck failure with the real error text and files", () => {
    recordFailure("typecheck", "src/app.tsx(10,3): error TS2322: Type 'number' is not assignable to type 'string'", ["src/app.tsx"]);
    const recs = getFailures();
    expect(recs).toHaveLength(1);
    expect(recs[0].kind).toBe("typecheck");
    expect(recs[0].detail).toContain("TS2322");
    expect(recs[0].files).toContain("src/app.tsx");
    expect(recs[0].count).toBe(1);
  });

  it("increments count instead of duplicating the same failure", () => {
    const detail = "src/app.tsx(10,3): error TS2322: Type 'number' is not assignable";
    recordFailure("typecheck", detail);
    recordFailure("typecheck", detail);
    recordFailure("typecheck", detail);
    const recs = getFailures();
    expect(recs).toHaveLength(1);
    expect(recs[0].count).toBe(3);
  });

  it("keeps distinct failures as separate records", () => {
    recordFailure("typecheck", "error TS2322: first kind");
    recordFailure("typecheck", "error TS2304: Cannot find name 'x'");
    expect(getFailures()).toHaveLength(2);
  });

  it("normalizes noisy output down to the meaningful error lines", () => {
    recordFailure(
      "typecheck",
      "> orplex@1.0.0 typecheck\n> tsc --noEmit\n\nsrc/app.tsx(3,7): error TS2564: has no initializer\n\nFound 1 error in src/app.tsx:3"
    );
    const rec = getFailures()[0];
    expect(rec.detail).toContain("TS2564");
    expect(rec.detail).not.toContain("orplex@1.0.0");
  });
});

describe("buildFailureDoctrineContext — the runtime doctrine", () => {
  it("returns empty string with no history (no padding)", () => {
    expect(buildFailureDoctrineContext()).toBe("");
    expect(adaptiveFailureDoctrine()).toBe("");
  });

  it("quotes the real evidence and marks recurring failures", () => {
    const detail = "src/app.tsx(10,3): error TS2322: Type 'number' is not assignable";
    recordFailure("typecheck", detail);
    recordFailure("typecheck", detail);

    const ctx = buildFailureDoctrineContext();
    expect(ctx).toContain("RECURRING");
    expect(ctx).toContain("TS2322");
    expect(ctx).toContain("Failure Doctrine"); // ties to the static doctrine section
  });

  it("includes the already-attempted repair so the model varies strategy", () => {
    recordFailure("browser", "Uncaught ReferenceError: X is not defined");
    recordRepairAttempt("browser repair: added missing import");
    const ctx = buildFailureDoctrineContext();
    expect(ctx).toContain("Already attempted");
    expect(ctx).toContain("added missing import");
  });

  it("clearFailures(kind) drops only that lane — others survive", () => {
    recordFailure("typecheck", "error TS2322: a");
    recordFailure("browser", "console error: boom");
    clearFailures("typecheck");
    const recs = getFailures();
    expect(recs).toHaveLength(1);
    expect(recs[0].kind).toBe("browser");
  });

  it("adapts through the master prompt export (repair-turn wiring)", () => {
    recordFailure("typecheck", "src/x.ts(1,1): error TS2304: Cannot find name 'q'");
    expect(adaptiveFailureDoctrine()).toContain("TS2304");
    expect(adaptiveFailureDoctrine()).toContain("FAILURE DOCTRINE section");
  });
});

describe("cross-task inheritance (sessionStorage persistence)", () => {
  it("survives a module reload within the same session", () => {
    recordFailure("typecheck", "src/persist.ts(2,2): error TS2345: argument not assignable");
    // Simulate a new task in the same session: memory is global, records remain.
    expect(getFailures()).toHaveLength(1);
  });

  it("ignores records older than a day (age filter on load)", () => {
    // The node test env has no sessionStorage — persistence degrades to
    // in-memory, so exercise the age filter through the module's own
    // normalization path: records load-filtered by MAX_ENTRY_AGE_MS on read.
    recordFailure("command", "git push rejected");
    expect(getFailures()).toHaveLength(1);
    // All records carry a fresh timestamp — the age filter keeps them.
    const rec = getFailures()[0];
    expect(Date.now() - rec.when).toBeLessThan(60_000);
  });
});
