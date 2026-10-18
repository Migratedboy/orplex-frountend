/**
 * acceptance.test.ts — Phase 2 acceptance-first spec model: deterministic
 * extraction from task text, schema validation, and the summary roll-up.
 */
import {
  acceptanceItemSchema,
  acceptanceSpecSchema,
  extractAcceptanceFromTask,
  summarizeAcceptance,
  type AcceptanceSpec,
} from "../reliability/acceptance";

describe("schemas", () => {
  it("accepts a well-formed item and spec", () => {
    const item = acceptanceItemSchema.parse({
      id: "acc-1",
      statement: "typecheck passes",
      verifiedBy: "typecheck",
      evidence: "tsc exit 0",
      status: "verified",
    });
    expect(item.evidence).toBe("tsc exit 0");

    const spec = acceptanceSpecSchema.parse({
      items: [item],
      source: "user",
    });
    expect(spec.items).toHaveLength(1);
  });

  it("rejects bad enums and missing fields", () => {
    expect(acceptanceItemSchema.safeParse({ id: "a", statement: "s", verifiedBy: "magic", status: "unverified" }).success).toBe(false);
    expect(acceptanceItemSchema.safeParse({ id: "a", statement: "s", verifiedBy: "test", status: "kinda" }).success).toBe(false);
    expect(acceptanceItemSchema.safeParse({ statement: "s", verifiedBy: "none", status: "unverified" }).success).toBe(false);
    expect(acceptanceSpecSchema.safeParse({ items: [], source: "alien" }).success).toBe(false);
  });

  it("evidence is optional", () => {
    expect(acceptanceItemSchema.safeParse({ id: "a", statement: "s", verifiedBy: "manual", status: "unverified" }).success).toBe(true);
  });
});

describe("extractAcceptanceFromTask", () => {
  it("extracts checkboxes in order, all unverified with source derived", () => {
    const spec = extractAcceptanceFromTask(
      ["## Done when", "- [ ] typecheck passes", "- [x] jest suite is green", "* [X] browser lane renders"].join("\n")
    );
    expect(spec.source).toBe("derived");
    expect(spec.items.map(i => i.statement)).toEqual([
      "typecheck passes",
      "jest suite is green",
      "browser lane renders",
    ]);
    expect(spec.items.every(i => i.status === "unverified")).toBe(true);
  });

  it("infers verifiedBy deterministically from the statement", () => {
    const spec = extractAcceptanceFromTask(
      ["- [ ] tsc --noEmit is clean", "- [ ] unit tests cover the parser", "- [ ] the browser screenshot shows the modal", "- [ ] the README is updated"].join("\n")
    );
    expect(spec.items.map(i => i.verifiedBy)).toEqual(["typecheck", "test", "browser", "none"]);
  });

  it("falls back to 'must …' sentences when there are no checkboxes", () => {
    const spec = extractAcceptanceFromTask(
      "Fix the gate. The pipeline must refuse writes while a lane is red. The report must list unverified items."
    );
    expect(spec.items.map(i => i.statement)).toEqual([
      "The pipeline must refuse writes while a lane is red.",
      "The report must list unverified items.",
    ]);
  });

  it("does not duplicate a must-sentence already covered by a checkbox", () => {
    const spec = extractAcceptanceFromTask(
      ["- [ ] the gate must refuse writes", "The gate must refuse writes."].join("\n")
    );
    expect(spec.items).toHaveLength(1);
  });

  it("is deterministic: same input, same ids and order", () => {
    const text = "- [ ] a works\n- [ ] b works";
    expect(extractAcceptanceFromTask(text)).toEqual(extractAcceptanceFromTask(text));
  });

  it("content-addresses ids so they survive reordering", () => {
    const a = extractAcceptanceFromTask("- [ ] first\n- [ ] second");
    const b = extractAcceptanceFromTask("- [ ] second\n- [ ] first");
    const idFor = (spec: AcceptanceSpec, statement: string) =>
      spec.items.find(i => i.statement === statement)?.id;
    expect(idFor(a, "first")).toBe(idFor(b, "first"));
    expect(idFor(a, "second")).toBe(idFor(b, "second"));
  });

  it("returns an empty spec for text with no requirements", () => {
    const spec = extractAcceptanceFromTask("just do whatever");
    expect(spec.items).toEqual([]);
    expect(spec.source).toBe("derived");
  });

  it("every extracted spec validates against the schema", () => {
    const spec = extractAcceptanceFromTask("- [ ] x\nmust y\n- [ ] z");
    expect(acceptanceSpecSchema.safeParse(spec).success).toBe(true);
  });
});

describe("summarizeAcceptance", () => {
  const spec = (statuses: Array<AcceptanceSpec["items"][number]["status"]>): AcceptanceSpec => ({
    source: "derived",
    items: statuses.map((status, i) => ({
      id: `acc-${i}`,
      statement: `item ${i}`,
      verifiedBy: "none" as const,
      status,
    })),
  });

  it("counts each status", () => {
    const s = summarizeAcceptance(spec(["verified", "verified", "failed", "unverified", "unverified"]));
    expect(s).toEqual({ verified: 2, failed: 1, unverified: 2, complete: false });
  });

  it("is complete only when every item is verified", () => {
    expect(summarizeAcceptance(spec(["verified", "verified"])).complete).toBe(true);
    expect(summarizeAcceptance(spec(["verified", "unverified"])).complete).toBe(false);
    expect(summarizeAcceptance(spec(["verified", "failed"])).complete).toBe(false);
  });

  it("an empty spec is NOT complete — nothing verified is not the same as everything verified", () => {
    expect(summarizeAcceptance(spec([])).complete).toBe(false);
  });
});
