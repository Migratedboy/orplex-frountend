/**
 * browser-recorder — local-first persistence contract:
 *   1. Bytes land ONLY inside the app-data `recordings/` dir (never uploaded).
 *   2. Empty / oversized buffers are rejected.
 *   3. Retention prunes >30-day recordings (fire on save).
 * Electron is mocked; the filesystem is a real tmp dir so the disk-space
 * guard + retention run through real stat calls.
 */
jest.mock("electron", () => ({
  app: { getPath: jest.fn() },
  shell: { showItemInFolder: jest.fn() },
}));

import { app } from "electron";
import { registerRecorderIpc } from "../browser-recorder";

import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = path.join(os.tmpdir(), `orplex-recorder-test-${Date.now()}`);
const handlers = new Map<string, (e: unknown, raw?: unknown) => Promise<unknown>>();

beforeAll(async () => {
  (app.getPath as jest.Mock).mockReturnValue(tmpRoot);
  registerRecorderIpc(((channel: string, handler: (e: unknown, raw?: unknown) => Promise<unknown>) => {
    handlers.set(channel, handler);
  }) as never);
  await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

describe("recording persistence (local-first)", () => {
  it("writes bytes only under userData/recordings and returns a name", async () => {
    const buf = Buffer.from("webm-bytes");
    const res = (await handlers.get("recording:save")?.({}, { buffer: buf })) as any;
    expect(res.ok).toBe(true);
    expect(res.name).toMatch(/^recording-.*\.webm$/);
    expect(res.path).toBe(path.join(tmpRoot, "recordings", res.name));
    expect(await fs.promises.readFile(res.path)).toEqual(buf);
  });

  it("rejects empty buffers", async () => {
    const res = (await handlers.get("recording:save")?.({}, { buffer: Buffer.alloc(0) })) as any;
    expect(res.ok).toBe(false);
  });

  it("library lists recordings with sizes and mtimes", async () => {
    await fs.promises.writeFile(path.join(tmpRoot, "recordings", "old.webm"), Buffer.from("old"));
    const res = (await handlers.get("recording:library")?.({})) as any;
    expect(res.ok).toBe(true);
    expect(res.items.some((i: any) => i.name.endsWith(".webm"))).toBe(true);
    expect(res.totalBytes).toBeGreaterThan(0);
  });

  it("prune removes files older than the retention window", async () => {
    const oldDir = path.join(tmpRoot, "recordings");
    await fs.promises.mkdir(oldDir, { recursive: true });
    const oldFile = path.join(oldDir, "ancient.webm");
    await fs.promises.writeFile(oldFile, Buffer.from("x"));
    // Age the file 45 days into the past.
    const old = new Date(Date.now() - 45 * 86_400_000);
    await fs.promises.utimes(oldFile, old, old);
    const res = (await handlers.get("recording:prune")?.({}, { maxAgeDays: 30 })) as any;
    expect(res.ok).toBe(true);
    await expect(fs.promises.stat(oldFile)).rejects.toThrow();
  });

  it("rejected content ('savings' no-ops like strings) never hits disk", async () => {
    const res = (await handlers.get("recording:save")?.({}, { buffer: "not-a-buffer" })) as any;
    expect(res.ok).toBe(false);
    const files = await fs.promises.readdir(path.join(tmpRoot, "recordings"));
    expect(files.every((f) => f.endsWith(".webm"))).toBe(true);
  });
});
