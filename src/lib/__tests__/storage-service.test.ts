// Storage service tests — local driver roundtrip, dedup, integrity, GC.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHUNK_SIZE,
  StorageService,
  buildManifest,
  chunkBlob,
  gcStorage,
  sha256,
} from "../storage-service";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orplex-storage-"));
}

describe("storage service (local driver)", () => {
  let root: string;
  let svc: StorageService;

  beforeEach(() => {
    root = tmpRoot();
    svc = new StorageService({ driver: "local", localRoot: root });
  });

  test("chunkBlob splits at CHUNK_SIZE and dedupes identical content", () => {
    const chunk = Buffer.alloc(CHUNK_SIZE, 7);
    const data = Buffer.concat([chunk, chunk, Buffer.from("tail")]);
    const chunks = chunkBlob(data);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].hash).toBe(chunks[1].hash); // dedup by content
    expect(chunks[2].data.toString()).toBe("tail");
  });

  test("putBlob/getBlob roundtrips arbitrary payloads", async () => {
    const data = Buffer.from(JSON.stringify({ hello: "orplex", n: 42 }));
    const manifest = await svc.putBlob(data);
    expect(manifest.size).toBe(data.length);

    const back = await svc.getBlob(manifest);
    expect(back.equals(data)).toBe(true);
  });

  test("re-upload dedupes (same manifest hash, no growth)", async () => {
    const data = Buffer.alloc(CHUNK_SIZE + 100, 1);
    const m1 = await svc.putBlob(data);
    const m2 = await svc.putBlob(data);
    expect(m1.hash).toBe(m2.hash);
    expect(m1.chunks).toEqual(m2.chunks);
  });

  test("getBlob detects corrupted chunks via hash mismatch", async () => {
    const data = Buffer.from("integrity matters");
    const manifest = await svc.putBlob(data);
    // Corrupt the stored chunk on disk
    const chunkHash = manifest.chunks[0];
    const file = path.join(root, "chunks", chunkHash.slice(0, 2), chunkHash);
    fs.writeFileSync(file, Buffer.from("tampered!!!"), "utf8");
    await expect(svc.getBlob(manifest)).rejects.toThrow(/hash mismatch/);
  });

  test("getBlob rejects a tampered manifest (size mismatch)", async () => {
    const data = Buffer.from("size check");
    const manifest = await svc.putBlob(data);
    await expect(
      svc.getBlob({ ...manifest, size: manifest.size + 999 })
    ).rejects.toThrow(/size mismatch/);
  });

  test("buildManifest hash is content-addressed and stable", () => {
    const a = buildManifest(Buffer.from("same"));
    const b = buildManifest(Buffer.from("same"));
    const c = buildManifest(Buffer.from("different"));
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });

  test("gcStorage deletes only unreferenced chunks past the grace window", async () => {
    const keep = await svc.putBlob(Buffer.from("keep me"));
    const drop = await svc.putBlob(Buffer.from("drop me"));

    const referenced = new Set(keep.chunks);
    // Nothing deleted inside the grace window
    const r1 = await gcStorage(root, referenced, 60 * 60 * 1000);
    expect(r1.deleted).toBe(0);

    // Age every file past the window, then GC again
    const chunksDir = path.join(root, "chunks");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const prefix of fs.readdirSync(chunksDir)) {
      const dir = path.join(chunksDir, prefix);
      for (const name of fs.readdirSync(dir)) {
        fs.utimesSync(path.join(dir, name), old, old);
      }
    }
    const r2 = await gcStorage(root, referenced, 60 * 60 * 1000);
    expect(r2.deleted).toBeGreaterThan(0);
    expect(r2.bytesFreed).toBeGreaterThan(0);

    // The referenced blob survives, the dropped one is gone
    expect((await svc.getBlob(keep)).toString()).toBe("keep me");
    for (const h of drop.chunks) {
      await expect(svc.getChunk(h)).rejects.toThrow();
    }
  });

  test("sha256 is hex and stable", () => {
    const h = sha256("abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256("abc")).toBe(h);
  });
});
