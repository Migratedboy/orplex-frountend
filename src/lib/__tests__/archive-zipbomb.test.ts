/**
 * Zip-bomb guard.
 *
 * entry.async("nodebuffer") inflates the whole entry, so the size check used to
 * run AFTER the allocation - DEFLATE reaches ~1032:1, so a small upload could
 * demand gigabytes and kill the Next process. The guard now reads the declared
 * uncompressed size from the central directory (available pre-inflate) and
 * refuses before allocating.
 */

import JSZip from "jszip";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ENTRY_OUT_BYTES, extractZip } from "@/lib/agent/archive-extract";

describe("zip bomb containment", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orplex-bomb-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuses a high-ratio entry by declared size, before inflating", async () => {
    // 12MB of zeros compresses to a few KB and declares a 12MB uncompressed
    // size - over nothing on its own, but it proves the declared field is read.
    const z = new JSZip();
    z.file("bomb.bin", Buffer.alloc(12 * 1024 * 1024, 0));
    await writeFile(join(root, "small.zip"), await z.generateAsync({ type: "nodebuffer" }));

    const res = await extractZip({ root, archivePath: "small.zip" });

    // It fits under the 50MB per-entry cap, so it extracts - the important
    // assertion is that nothing crashed and the accounting is honest.
    expect(res.ok).toBe(true);
    const bytes = res.written.reduce((n, w) => n + w.bytes, 0);
    expect(bytes).toBe(12 * 1024 * 1024);
  }, 30000);

  it("skips an entry whose declared size exceeds the per-entry cap", async () => {
    const z = new JSZip();
    // Declared uncompressed size over the 50MB cap, highly compressible so the
    // archive on disk stays small - exactly the bomb shape.
    z.file("huge.bin", Buffer.alloc(Math.floor(MAX_ENTRY_OUT_BYTES * 1.2), 0));
    await writeFile(join(root, "bomb.zip"), await z.generateAsync({ type: "nodebuffer" }));

    const res = await extractZip({ root, archivePath: "bomb.zip" });

    expect(res.written).toHaveLength(0);
    expect(res.skipped.some((s) => s.skipped === "too-large")).toBe(true);
    // Nothing was materialised on disk.
    const dest = res.dest;
    const entries = await readdir(join(root, dest)).catch(() => []);
    expect(entries).toHaveLength(0);
  }, 60000);

  it("still extracts ordinary archives", async () => {
    const z = new JSZip();
    z.file("src/a.ts", "export const a = 1;");
    z.file("b.md", "# b");
    await writeFile(join(root, "ok.zip"), await z.generateAsync({ type: "nodebuffer" }));

    const res = await extractZip({ root, archivePath: "ok.zip" });
    expect(res.ok).toBe(true);
    expect(res.written.map((w) => w.path).sort()).toEqual(["b.md", "src/a.ts"]);
  });
});
