import { validateTaskGraph } from "../scheduler";

describe("task graph validation", () => {
  it("accepts a valid dependency graph", () => {
    expect(() => validateTaskGraph([
      { id: "architect", dependsOn: [] },
      { id: "developer-a", dependsOn: ["architect"] },
      { id: "developer-b", dependsOn: ["architect"] },
      { id: "reviewer", dependsOn: ["developer-a", "developer-b"] },
    ])).not.toThrow();
  });

  it("rejects missing dependencies", () => {
    expect(() => validateTaskGraph([
      { id: "developer", dependsOn: ["architect"] },
    ])).toThrow("depends on missing task architect");
  });

  it("rejects cycles and duplicate ids", () => {
    expect(() => validateTaskGraph([
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
    ])).toThrow("contains a cycle");

    expect(() => validateTaskGraph([
      { id: "a", dependsOn: [] },
      { id: "a", dependsOn: [] },
    ])).toThrow("duplicate");
  });
});
