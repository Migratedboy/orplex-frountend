/**
 * git-changes.test.ts — git status/numstat parsing for the Changes tab.
 */
import { parsePorcelain, parseNumstat, mergeCounts, totalsOf } from "../git-changes";

describe("parsePorcelain (non-z)", () => {
  it("classifies modified/added/deleted/renamed/untracked", () => {
    const raw = [
      " M src/app/page.tsx",
      "A  src/new.ts",
      " D src/old.ts",
      "R  src/old-name.ts -> src/new-name.ts",
      "?? README.md",
    ].join("\n");
    const rows = parsePorcelain(raw, false);
    expect(rows.map((r) => r.status)).toEqual(["modified", "added", "deleted", "renamed", "added"]);
    expect(rows[3].path).toBe("src/old-name.ts -> src/new-name.ts");
  });

  it("returns [] for empty output", () => {
    expect(parsePorcelain("", false)).toEqual([]);
  });
});

describe("parsePorcelain (z)", () => {
  it("handles NUL-separated entries and rename pairs", () => {
    const raw = [" M src/a.ts", "R  src/new.ts", "src/old.ts", "?? src/c.ts"].join("\0");
    const rows = parsePorcelain(raw, true);
    expect(rows[0]).toEqual({ path: "src/a.ts", status: "modified", added: 0, deleted: 0 });
    expect(rows[1]).toEqual({ path: "src/old.ts -> src/new.ts", status: "renamed", added: 0, deleted: 0 });
    expect(rows[2]).toEqual({ path: "src/c.ts", status: "added", added: 0, deleted: 0 });
  });
});

describe("parseNumstat + merge + totals", () => {
  it("parses counts, maps binary dashes to zero, merges by path", () => {
    const rows = parsePorcelain(" M src/a.ts\n?? src/c.ts", false);
    const counts = parseNumstat("5\t2\tsrc/a.ts\n-\t-\timg.png", false);
    const merged = mergeCounts(rows, counts);
    expect(merged[0]).toEqual({ path: "src/a.ts", status: "modified", added: 5, deleted: 2 });
    expect(merged[1]).toEqual({ path: "src/c.ts", status: "added", added: 0, deleted: 0 });
    expect(totalsOf(merged)).toEqual({ added: 5, deleted: 2 });
  });

  it("parses -z numstat rename pairs", () => {
    const raw = ["5\t1\t", "src/old.ts", "src/new.ts"].join("\0");
    const counts = parseNumstat(raw, true);
    expect(counts.get("src/new.ts")).toEqual({ added: 5, deleted: 1 });
  });
});
