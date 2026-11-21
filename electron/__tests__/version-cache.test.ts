import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearCachesOnVersionChange, readCachedVersion, writeCachedVersion } from "../version-cache";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orplex-cachever-"));
}

describe("version marker", () => {
  it("round-trips the cleared version", () => {
    const dir = tmp();
    expect(readCachedVersion(dir)).toBeNull();
    writeCachedVersion(dir, "3.0.4", new Date("2026-01-02T03:04:05.000Z"));
    expect(readCachedVersion(dir)).toBe("3.0.4");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "cache-version.json"), "utf8"))).toEqual({
      version: "3.0.4",
      clearedAt: "2026-01-02T03:04:05.000Z",
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("treats a corrupt marker as 'never cleared'", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "cache-version.json"), "{not json");
    expect(readCachedVersion(dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("clearCachesOnVersionChange", () => {
  it("clears once per version, not on every boot", async () => {
    const dir = tmp();
    const clear = jest.fn(async () => {});
    await expect(clearCachesOnVersionChange({ userDataDir: dir, version: "3.0.3", clear })).resolves.toBe(true);
    expect(clear).toHaveBeenCalledTimes(1);
    // Same version, second boot: nothing to do.
    await expect(clearCachesOnVersionChange({ userDataDir: dir, version: "3.0.3", clear })).resolves.toBe(false);
    expect(clear).toHaveBeenCalledTimes(1);
    // Update: clear again.
    await expect(clearCachesOnVersionChange({ userDataDir: dir, version: "3.0.4", clear })).resolves.toBe(true);
    expect(clear).toHaveBeenCalledTimes(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not record the version when the clear fails, so it retries next boot", async () => {
    const dir = tmp();
    const clear = jest.fn(async () => {
      throw new Error("cache locked");
    });
    await expect(clearCachesOnVersionChange({ userDataDir: dir, version: "3.0.4", clear })).resolves.toBe(false);
    expect(readCachedVersion(dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
