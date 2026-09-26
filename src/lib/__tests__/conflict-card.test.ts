// ConflictCard helper tests — hunk resolution semantics.

import { applyResolutions, resolveHunk, type ConflictHunk } from "../../components/ConflictCard";

const HUNK: ConflictHunk = {
  id: "h1",
  file: "src/a.ts",
  lineHint: 12,
  base: "",
  ours: "const fast = true;",
  theirs: "const slow = false;",
};

describe("conflict resolution helpers", () => {
  test("resolveHunk: both keeps ours then theirs", () => {
    expect(resolveHunk(HUNK, "both")).toEqual(["const fast = true;", "const slow = false;"]);
  });

  test("resolveHunk: ours/theirs pick a single side", () => {
    expect(resolveHunk(HUNK, "ours")).toEqual(["const fast = true;"]);
    expect(resolveHunk(HUNK, "theirs")).toEqual(["const slow = false;"]);
  });

  test("resolveHunk: empty sides contribute no lines", () => {
    const emptyOurs = { ...HUNK, ours: "" };
    expect(resolveHunk(emptyOurs, "ours")).toEqual([]);
    expect(resolveHunk(emptyOurs, "both")).toEqual(["const slow = false;"]);
  });

  test("applyResolutions replaces conflict markers with the chosen text", () => {
    const text = [
      "before",
      "<<<<<<< h1",
      "const fast = true;",
      "=======",
      "const slow = false;",
      ">>>>>>>",
      "after",
    ].join("\n");

    const both = applyResolutions(text, [HUNK], {});
    expect(both).toBe(["before", "const fast = true;", "const slow = false;", "after"].join("\n"));

    const theirs = applyResolutions(text, [HUNK], { h1: "theirs" });
    expect(theirs).toBe(["before", "const slow = false;", "after"].join("\n"));
  });

  test("applyResolutions leaves text unchanged when markers are missing", () => {
    const text = "no conflicts here";
    expect(applyResolutions(text, [HUNK], {})).toBe(text);
  });
});
