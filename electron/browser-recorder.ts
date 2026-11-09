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
}
