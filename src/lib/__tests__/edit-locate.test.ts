import {
  locateFirstRange,
  locateLastRange,
  locateUniqueRange,
} from "../edit-locate";

describe("edit-locate", () => {
  it("finds an exact match first", () => {
    const content = "const a = 1;\nconst b = 2;\n";
    expect(locateFirstRange(content, "const b = 2;")).toEqual({
      start: content.indexOf("const b = 2;"),
      end: content.indexOf("const b = 2;") + "const b = 2;".length,
    });
  });

  it("re-locates a \\n target inside a CRLF file and maps indexes back", () => {
    const content = "const a = 1;\r\nconst b = 2;\r\n";
    const range = locateFirstRange(content, "const b = 2;");
    expect(range).not.toBeNull();
    expect(content.slice(range!.start, range!.end)).toBe("const b = 2;");
  });

  it("returns null when the target is genuinely absent", () => {
    expect(locateFirstRange("const a = 1;\n", "not there")).toBeNull();
  });

  it("returns null when there are no CRLFs and the exact match missed", () => {
    expect(locateFirstRange("const a = 1;\n", "const a =  1;")).toBeNull();
  });

  it("handles a target that spans a CRLF boundary", () => {
    const content = "line one\r\nline two\r\n";
    const range = locateFirstRange(content, "one\nline two");
    expect(range).not.toBeNull();
    expect(content.slice(range!.start, range!.end).startsWith("one")).toBe(true);
    expect(content.slice(range!.start, range!.end).endsWith("line two")).toBe(true);
  });

  it("finds the last match for locateLastRange", () => {
    const content = "let x = 1;\nlet y = 2;\n";
    const first = locateFirstRange(content, "let");
    const last = locateLastRange(content, "let");
    expect(first!.start).toBe(0);
    expect(last!.start).toBe(content.indexOf("let y"));
  });

  it("locateUniqueRange returns the single exact match", () => {
    const content = "alpha\nbeta\ngamma\n";
    expect(locateUniqueRange(content, "beta")).toEqual({
      start: 6,
      end: 10,
    });
  });

  it("locateUniqueRange refuses a target that matches more than once exactly", () => {
    expect(locateUniqueRange("dup\ndup\n", "dup")).toBeNull();
  });

  it("locateUniqueRange falls back to the unique normalized match", () => {
    const content = "alpha\r\nbeta\r\n";
    const range = locateUniqueRange(content, "alpha\nbeta");
    expect(range).not.toBeNull();
    expect(content.slice(range!.start, range!.end)).toBe("alpha\r\nbeta");
  });

  it("locateUniqueRange returns null for empty targets or empty content", () => {
    expect(locateUniqueRange("something", "")).toBeNull();
    expect(locateUniqueRange("", "x")).toBeNull();
  });
});
