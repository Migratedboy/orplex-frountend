// app-version.test.ts — semver floor compare for the 426 handshake.
import { parseVersion, meetsMinimum } from "../app-version";

describe("parseVersion", () => {
  it("parses full versions", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
  });
  it("tolerates v prefix, missing parts, suffixes", () => {
    expect(parseVersion("v1.0")).toEqual([1, 0, 0]);
    expect(parseVersion("2.0.0-beta.1")).toEqual([2, 0, 0]);
    expect(parseVersion("garbage")).toEqual([0, 0, 0]);
  });
});

describe("meetsMinimum", () => {
  it("accepts equal and newer", () => {
    expect(meetsMinimum("1.0.1", "1.0.1")).toBe(true);
    expect(meetsMinimum("1.2.0", "1.0.9")).toBe(true);
    expect(meetsMinimum("2.0.0", "1.9.9")).toBe(true);
  });
  it("rejects older patch/minor/major", () => {
    expect(meetsMinimum("1.0.0", "1.0.1")).toBe(false);
    expect(meetsMinimum("1.0.9", "1.2.0")).toBe(false);
    expect(meetsMinimum("1.9.9", "2.0.0")).toBe(false);
  });
});
