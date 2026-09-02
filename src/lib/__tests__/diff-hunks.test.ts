import {
  parseDiffHunks,
  filterDiffByHunks,
  applyDiffToText,
} from "../diff-hunks";

describe("parseDiffHunks", () => {
  it("returns empty for no-change diffs", () => {
    expect(parseDiffHunks("")).toEqual([]);
    expect(parseDiffHunks("(no changes)")).toEqual([]);
  });

  it("parses a single-add diff into one hunk", () => {
    const hunks = parseDiffHunks("+ const x = 1;");
    expect(hunks).toHaveLength(1);
    expect(hunks[0].added).toBe(1);
    expect(hunks[0].removed).toBe(0);
    expect(hunks[0].lines[0]).toEqual({ type: "add", text: "const x = 1;" });
  });

  it("separates distant changes into distinct hunks", () => {
    const diff = [
      "- old line one",
      "+ new line one",
      "context",
      "context",
      "- another removal",
      "+ another addition",
    ].join("\n");
    const hunks = parseDiffHunks(diff);
    expect(hunks.length).toBe(2);
    expect(hunks[0].added).toBe(1);
    expect(hunks[1].added).toBe(1);
  });

  it("keeps changes separated by a single context line in one hunk", () => {
    const diff = [
      "- first removal",
      "+ first addition",
      "context between",
      "- second removal",
      "+ second addition",
    ].join("\n");
    const hunks = parseDiffHunks(diff);
    expect(hunks).toHaveLength(1);
  });

  it("strips file headers", () => {
    const diff = ["--- src/a.ts", "+++ src/a.ts", "+ added"].join("\n");
    const hunks = parseDiffHunks(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines.some(l => l.text.includes("src/a.ts"))).toBe(false);
  });

  it("collapses new-file summaries to a single hunk", () => {
    const diff = [
      "+ [New file: 100 lines]",
      "+ line one",
      "+ line two",
      "+ ...",
    ].join("\n");
    const hunks = parseDiffHunks(diff);
    expect(hunks).toHaveLength(1);
  });
});

describe("filterDiffByHunks", () => {
  const diff = [
    "- removed a",
    "+ added a",
    "context",
    "context",
    "- removed b",
    "+ added b",
  ].join("\n");

  it("keeps only accepted hunks", () => {
    const filtered = filterDiffByHunks(diff, new Set([0]));
    expect(filtered).toContain("added a");
    expect(filtered).not.toContain("added b");
  });

  it("drops everything when nothing is accepted", () => {
    expect(filterDiffByHunks(diff, new Set())).toBe("");
  });

  it("round-trips through parse", () => {
    const hunks = parseDiffHunks(diff);
    const all = new Set(hunks.map(h => h.id));
    const filtered = filterDiffByHunks(diff, all);
    // Re-parsing the kept content yields the same number of change lines
    const reparsed = parseDiffHunks(filtered);
    expect(reparsed.reduce((n, h) => n + h.added, 0)).toBe(2);
  });
});

describe("applyDiffToText", () => {
  it("applies additions and removals against old text", () => {
    const oldText = ["function a() {", "  return 1;", "}", ""].join("\n");
    const diff = ["function a() {", "-   return 1;", "+   return 2;", "}"].join("\n");
    const result = applyDiffToText(oldText, diff);
    expect(result).toContain("return 2;");
    expect(result).not.toContain("return 1;");
    expect(result).toContain("function a() {");
    expect(result).toContain("}");
  });

  it("preserves untouched trailing lines", () => {
    const oldText = ["keep me", "drop me", "keep me too"].join("\n");
    const diff = ["keep me", "- drop me"].join("\n");
    const result = applyDiffToText(oldText, diff);
    expect(result.split("\n")).toEqual(["keep me", "keep me too"]);
  });

  it("returns old text unchanged for an empty diff", () => {
    const oldText = ["a", "b"].join("\n");
    expect(applyDiffToText(oldText, "")).toBe(oldText);
  });
});
