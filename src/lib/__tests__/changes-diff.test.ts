import { diffFileLines } from "../changes-diff";

describe("diffFileLines", () => {
  it("counts a real edit and emits context-limited unified hunks", () => {
    const diff = diffFileLines(
      "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight",
      "one\ntwo\nthree\nFOUR\nfive\nsix\nseven\neight",
    );

    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.lines[0]).toEqual({ kind: "hunk", text: "@@ -1,7 +1,7 @@" });
    expect(diff.lines.some((line) => line.kind === "remove" && line.text === "four")).toBe(true);
    expect(diff.lines.some((line) => line.kind === "add" && line.text === "FOUR")).toBe(true);
  });

  it("renders new and deleted files as all-added or all-removed", () => {
    expect(diffFileLines(null, "a\nb")).toMatchObject({
      added: 2,
      removed: 0,
      lines: [
        { kind: "hunk", text: "@@ new file @@" },
        { kind: "add", text: "a" },
        { kind: "add", text: "b" },
      ],
    });
    expect(diffFileLines("a\nb", null)).toMatchObject({
      added: 0,
      removed: 2,
      lines: [
        { kind: "hunk", text: "@@ deleted file @@" },
        { kind: "remove", text: "a" },
        { kind: "remove", text: "b" },
      ],
    });
  });

  it("returns no changes for an identical snapshot", () => {
    expect(diffFileLines("same", "same")).toEqual({ added: 0, removed: 0, lines: [] });
  });
});
