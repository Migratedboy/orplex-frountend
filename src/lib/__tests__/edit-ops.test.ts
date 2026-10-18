/**
 * edit-ops.test.ts — Phase 3 structured edit-operation model.
 *
 * parseEditOp is the boundary between untrusted model output and the EditOp
 * union; every shape the plan specifies is exercised both ways, including the
 * two properties the legacy string tools do not have: non-recursive batches
 * and the occurrence enum (the fix for String.replace's silent first-match
 * pick).
 */
import {
  EDIT_OPS_TOOL_NAME,
  editOpSchema,
  parseEditOp,
} from "../reliability/edit-ops";
import {
  reliabilityEditOpsEnabled,
  reliabilityGatesEnabled,
} from "../reliability/flags";

describe("edit-ops model", () => {
  it("exposes the tool name the plan wires under", () => {
    expect(EDIT_OPS_TOOL_NAME).toBe("apply_edit_ops");
  });

  it("parses a minimal create_file", () => {
    const r = parseEditOp({ op: "create_file", path: "src/a.ts", content: "export {};\n" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.op.op).toBe("create_file");
  });

  it("parses create_file with expectedAbsence", () => {
    const r = parseEditOp({ op: "create_file", path: "a.txt", content: "", expectedAbsence: true });
    expect(r.ok).toBe(true);
    // zod literal(true) — anything other than boolean true is refused.
    expect(parseEditOp({ op: "create_file", path: "a.txt", content: "", expectedAbsence: "yes" }).ok).toBe(false);
  });

  it("parses replace_text with every occurrence mode", () => {
    for (const occurrence of ["first", "all", "exactly_one"] as const) {
      const r = parseEditOp({ op: "replace_text", path: "a.ts", oldText: "x", newText: "y", occurrence });
      expect(r.ok).toBe(true);
    }
    expect(
      parseEditOp({ op: "replace_text", path: "a.ts", oldText: "x", newText: "y", occurrence: "sometimes" }).ok,
    ).toBe(false);
  });

  it("parses replace_text with expectedHash", () => {
    const r = parseEditOp({ op: "replace_text", path: "a.ts", oldText: "x", newText: "y", expectedHash: "deadbeef" });
    expect(r.ok).toBe(true);
  });

  it("rejects an empty oldText (it could never match anything)", () => {
    expect(parseEditOp({ op: "replace_text", path: "a.ts", oldText: "", newText: "y" }).ok).toBe(false);
  });

  it("parses insert_at with a 1-based integer line", () => {
    expect(parseEditOp({ op: "insert_at", path: "a.ts", line: 1, content: "x" }).ok).toBe(true);
    expect(parseEditOp({ op: "insert_at", path: "a.ts", line: 0, content: "x" }).ok).toBe(false);
    expect(parseEditOp({ op: "insert_at", path: "a.ts", line: 1.5, content: "x" }).ok).toBe(false);
  });

  it("parses delete_file and move_file", () => {
    expect(parseEditOp({ op: "delete_file", path: "a.ts", expectedHash: "0badf00d" }).ok).toBe(true);
    expect(parseEditOp({ op: "move_file", from: "a.ts", to: "b.ts" }).ok).toBe(true);
    expect(parseEditOp({ op: "move_file", from: "a.ts" }).ok).toBe(false);
  });

  it("parses a batch of base ops", () => {
    const r = parseEditOp({
      op: "batch",
      ops: [
        { op: "create_file", path: "a.ts", content: "" },
        { op: "replace_text", path: "b.ts", oldText: "x", newText: "y" },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("refuses a NESTED batch — batches are one level deep by construction", () => {
    const r = parseEditOp({
      op: "batch",
      ops: [{ op: "batch", ops: [{ op: "create_file", path: "a.ts", content: "" }] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ops");
  });

  it("refuses an unknown op and a missing path, with a readable error", () => {
    const unknown = parseEditOp({ op: "teleport_file", path: "a.ts" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.length).toBeGreaterThan(0);

    const noPath = parseEditOp({ op: "delete_file" });
    expect(noPath.ok).toBe(false);
    if (!noPath.ok) expect(noPath.error).toContain("path");
  });

  it("strips unknown keys rather than rejecting (never stricter than needed)", () => {
    const r = parseEditOp({ op: "create_file", path: "a.ts", content: "", hallucinated: 42 });
    expect(r.ok).toBe(true);
    if (r.ok) expect("hallucinated" in r.op).toBe(false);
  });

  it("exposes the schema for registry composition", () => {
    expect(editOpSchema.safeParse({ op: "delete_file", path: "a.ts" }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Flag — default OFF, master switch required (flags.ts pattern)
// ---------------------------------------------------------------------------

describe("RELIABILITY_EDIT_OPS flag", () => {
  const ENV = process.env;
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ENV };
    delete process.env.RELIABILITY_GATES;
    delete process.env.RELIABILITY_EDIT_OPS;
  });
  afterAll(() => {
    process.env = ENV;
  });

  it("is OFF when nothing is set", () => {
    expect(reliabilityEditOpsEnabled()).toBe(false);
  });

  it("stays OFF when only RELIABILITY_EDIT_OPS is set — the master switch arms everything", () => {
    process.env.RELIABILITY_EDIT_OPS = "1";
    expect(reliabilityGatesEnabled()).toBe(false);
    expect(reliabilityEditOpsEnabled()).toBe(false);
  });

  it("turns ON only when both switches are on", () => {
    process.env.RELIABILITY_GATES = "1";
    expect(reliabilityEditOpsEnabled()).toBe(false);
    process.env.RELIABILITY_EDIT_OPS = "1";
    expect(reliabilityEditOpsEnabled()).toBe(true);
  });
});
