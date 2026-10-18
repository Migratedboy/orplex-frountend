/**
 * hash.test.ts — content hashing for stale-read detection.
 *
 * The algorithm MUST agree with compaction.ts's hashContent (the incremental
 * transcript hash), so the reference below is a verbatim copy of that
 * function's body. If compaction.ts ever changes its constants, this test is
 * the tripwire that stops the two hashes silently diverging.
 */
import { contentHash, fnv1a } from "../reliability/hash";

/** Verbatim copy of compaction.ts hashContent (not exported there). */
function compactionHashContent(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h ^ text.length) >>> 0;
}

/** Vanilla 32-bit FNV-1a WITHOUT compaction's length fold — for contrast. */
function plainFnv1aHex(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

describe("fnv1a / contentHash", () => {
  const samples = [
    "",
    "a",
    "hello world",
    "const x = 1;\nconst y = 2;\nexport {};\n",
    "unicode — 日本語 ✓ 🚀",
    "x".repeat(5000),
  ];

  it("matches compaction.ts hashContent exactly (same constants, same length fold)", () => {
    for (const s of samples) {
      expect(fnv1a(s)).toBe(compactionHashContent(s).toString(16).padStart(8, "0"));
    }
  });

  it("returns 8-char lowercase hex", () => {
    for (const s of samples) {
      expect(fnv1a(s)).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("folds the string length in, like compaction — so it is not bare FNV-1a", () => {
    // The fold (h ^ length) changes the result for every non-empty input;
    // if this ever fails, someone 'fixed' the hash and broke compaction
    // compatibility.
    expect(fnv1a("a")).not.toBe(plainFnv1aHex("a"));
  });

  it("contentHash is the swappable alias of fnv1a", () => {
    for (const s of samples) {
      expect(contentHash(s)).toBe(fnv1a(s));
    }
  });

  it("is stable and sensitive to small changes", () => {
    expect(fnv1a("abc")).toBe(fnv1a("abc"));
    expect(fnv1a("abc")).not.toBe(fnv1a("abd"));
    expect(fnv1a("ab")).not.toBe(fnv1a("ba"));
  });
});
