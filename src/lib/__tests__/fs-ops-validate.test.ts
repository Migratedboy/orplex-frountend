/**
 * fs-ops-validate.test.ts — Files-tab write validation (reserved names, jail).
 */
import { validateEntryName, normalizeRelPath, MAX_PATH_LENGTH } from "../fs-ops-validate";

describe("validateEntryName", () => {
  it("accepts ordinary names incl. dotfiles and dotted names", () => {
    expect(validateEntryName("report.md")).toEqual({ ok: true });
    expect(validateEntryName(".github")).toEqual({ ok: true });
    expect(validateEntryName("con-fix.ts")).toEqual({ ok: true });
  });

  it("rejects empties, illegal chars, and paths smuggled as names", () => {
    expect(validateEntryName("   ").ok).toBe(false);
    expect(validateEntryName("a<b").ok).toBe(false);
    expect(validateEntryName("a/b").ok).toBe(false);
    expect(validateEntryName("a\\b").ok).toBe(false);
    expect(validateEntryName("trailing.").ok).toBe(false);
  });

  it("rejects Windows reserved device names (stem, incl. with extension)", () => {
    for (const name of ["con", "CON.txt", "prn", "aux.ts", "nul", "com1", "LPT9.log"]) {
      expect(validateEntryName(name).ok).toBe(false);
    }
  });
});

describe("normalizeRelPath", () => {
  it("normalizes backslashes and trims segments", () => {
    expect(normalizeRelPath("src\\lib\\a.ts")).toBe("src/lib/a.ts");
    expect(normalizeRelPath("  src/lib/a.ts  ")).toBe("src/lib/a.ts");
    expect(normalizeRelPath("a//b")).toBe("a/b");
  });

  it("rejects absolute paths and .. traversal", () => {
    expect(normalizeRelPath("C:\\Users\\x")).toBeNull();
    expect(normalizeRelPath("/abs/path")).toBeNull();
    expect(normalizeRelPath("../escape")).toBeNull();
    expect(normalizeRelPath("a/../../escape")).toBeNull();
    expect(normalizeRelPath("a/../b")).toBeNull();
  });

  it("rejects reserved segments and over-length paths", () => {
    expect(normalizeRelPath("src/../con")).toBeNull();
    expect(normalizeRelPath("x".repeat(MAX_PATH_LENGTH + 1))).toBeNull();
  });
});
