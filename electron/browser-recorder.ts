/**
 * browser-recorder.ts — recording file persistence (Right Panel v2, P5; D9).
 * The renderer captures MediaRecorder webm (cropped to preview bounds via a
 * canvas stream from the app's own window); main only writes the bytes under
 * userData/recordings/ and reveals them on request.
 */
import { app, shell } from "electron";
import fs from "node:fs";
import path from "node:path";

type HandleFn = (channel: string, handler: (event: any, ...args: any[]) => any) => void;

export function registerRecorderIpc(handleAppIpc: HandleFn): void {
  handleAppIpc("recording:save", async (_e: unknown, raw: any) => {
    try {
      const buf: Buffer | null = Buffer.isBuffer(raw?.buffer)
        ? raw.buffer
        : raw?.buffer instanceof ArrayBuffer
          ? Buffer.from(raw.buffer)
          : raw?.buffer instanceof Uint8Array
            ? Buffer.from(raw.buffer)
            : null;
      if (!buf || buf.length === 0) return { ok: false, error: "Empty recording" };
      if (buf.length > 512 * 1024 * 1024) return { ok: false, error: "Recording exceeds the 512 MB save cap" };
      const dir = path.join(app.getPath("userData"), "recordings");
      await fs.promises.mkdir(dir, { recursive: true });
      // Disk-space guard (local-first means recordings must never take the
      // machine down to zero free space): keep 200 MB headroom.
      try {
        const stats = await fs.promises.statfs(dir);
        const freeBytes = Number(stats.bfree) * Number(stats.bsize);
        if (freeBytes < buf.length + 200 * 1024 * 1024) {
          return { ok: false, error: "Not enough disk space to save recording" };
        }
      } catch {
        // statfs unavailable on this platform — proceed (save cap still applies).
      }
      // Retention: recordings are per-machine artifacts; auto-prune anything
      // older than 30 days so the library can't grow across machines silently.
      await pruneOldRecordings(dir, 30).catch(() => {});
      const name = `recording-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
      const full = path.join(dir, name);
      await fs.promises.writeFile(full, buf);
      return { ok: true, path: full, name };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || String(err) };
    }
  });

  handleAppIpc("recording:reveal", (_e: unknown, raw: any) => {
    const p = String(raw?.path ?? "");
    if (!p) return { ok: false };
    shell.showItemInFolder(p);
    return { ok: true };
  });

  // Local library introspection + retention (metadata-only listing; the
  // bytes never leave this machine — DATA-STORES.md §Recordings).
  handleAppIpc("recording:library", async () => {
    try {
      const dir = path.join(app.getPath("userData"), "recordings");
      await fs.promises.mkdir(dir, { recursive: true });
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const files = await Promise.all(
        entries
          .filter((e) => e.isFile())
          .map(async (e) => {
            const full = path.join(dir, e.name);
            const st = await fs.promises.stat(full).catch(() => null);
            return st ? { name: e.name, path: full, sizeBytes: st.size, mtimeMs: st.mtimeMs } : null;
          }),
      );
      const items = files.filter(Boolean) as Array<{ name: string; path: string; sizeBytes: number; mtimeMs: number }>;
      return { ok: true, items, totalBytes: items.reduce((sum, f) => sum + f.sizeBytes, 0) };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || String(err) };
    }
  });

  handleAppIpc("recording:prune", async (_e: unknown, raw: any) => {
    try {
      const maxAgeDays = Math.max(1, Math.min(365, Number(raw?.maxAgeDays) || 30));
      const dir = path.join(app.getPath("userData"), "recordings");
      await fs.promises.mkdir(dir, { recursive: true });
      const removed = await pruneOldRecordings(dir, maxAgeDays);
      return { ok: true, removed };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || String(err) };
    }
  });
}

async function pruneOldRecordings(dir: string, maxAgeDays: number): Promise<number> {
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as any[]);
  let removed = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(dir, e.name);
    const st = await fs.promises.stat(full).catch(() => null);
    if (st && st.mtimeMs < cutoff) {
      await fs.promises.rm(full, { force: true }).catch(() => {});
      removed++;
    }
  }
  return removed;
}
