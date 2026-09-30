// grep-search.test.ts — The engine chain's contract: literal vs regex
// handling, engine reporting, output caps. Tests run against a temp dir with
// a controlled file set; the chain selection itself depends on what's
// installed (rg may or may not exist on CI), so engine assertions are loose.
import { grepSearch, MAX_SEARCH_MATCHES } from "../grep-search";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "grep-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("grepSearch", () => {
  it("finds literal matches across files with path:line: text format", async () => {
    await writeFile(path.join(dir, "a.ts"), "const alpha = 1;\nconst beta = 2;\n");
    await writeFile(path.join(dir, "b.ts"), "// beta appears here too\n");

    const result = await grepSearch(dir, "beta");
    expect(result).not.toBeNull();
    expect(result!.matchCount).toBeGreaterThanOrEqual(2);
    expect(result!.output).toMatch(/a\.ts:2:.*beta/);
    expect(result!.output).toMatch(/b\.ts:1:.*beta/);
    expect(result!.truncated).toBe(false);
  });

  it("treats regex metacharacters as literals by default", async () => {
    await writeFile(path.join(dir, "c.ts"), "price.isHere(x);\n");
    const result = await grepSearch(dir, "price.is"); // '.' would regex-match anything
    expect(result).not.toBeNull();
    expect(result!.output).toContain("price.isHere");
  });

  it("respects isRegex mode", async () => {
    await writeFile(path.join(dir, "d.ts"), "foo123\nbar\n");
    const result = await grepSearch(dir, "foo\\d+", { isRegex: true });
    expect(result).not.toBeNull();
    expect(result!.output).toContain("foo123");
  });

  it("returns empty output for no matches (not null)", async () => {
    await writeFile(path.join(dir, "e.ts"), "nothing here\n");
    const result = await grepSearch(dir, "zzz_not_present_zzz");
    expect(result).not.toBeNull();
    expect(result!.output).toBe("");
    expect(result!.matchCount).toBe(0);
  });

  it("rejects empty and oversized patterns", async () => {
    expect(await grepSearch(dir, "")).toBeNull();
    expect(await grepSearch(dir, "x".repeat(501))).toBeNull();
  });

  it("caps output when matches exceed the limit", async () => {
    // Engines cap matches per file (--max-count 5), so spread matches across
    // enough files to exceed the global cap: 50 files × 5 = 250 > 200.
    for (let f = 0; f < 50; f++) {
      await writeFile(
        path.join(dir, `hot${f}.txt`),
        Array.from({ length: 5 }, (_, i) => `file${f} line${i} needle`).join("\n")
      );
    }
    const result = await grepSearch(dir, "needle");
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.matchCount).toBeGreaterThan(MAX_SEARCH_MATCHES);
  });

  it("limits matches per file so one hot file can't flood results", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `hot line ${i}`).join("\n");
    await writeFile(path.join(dir, "one-hot.txt"), lines);
    const result = await grepSearch(dir, "hot line");
    expect(result).not.toBeNull();
    expect(result!.matchCount).toBeLessThanOrEqual(5);
  });

  it("searches nested directories", async () => {
    await (await import("fs/promises")).mkdir(path.join(dir, "nested"), { recursive: true });
    await writeFile(path.join(dir, "nested", "deep.ts"), "const deepTarget = true;\n");
    const result = await grepSearch(dir, "deepTarget");
    expect(result).not.toBeNull();
    expect(result!.output).toContain("deep.ts");
  });
});
