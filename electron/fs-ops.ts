/**
 * fs-ops.ts — desktop file operations for the Files tab (Right Panel v2, P3;
 * DECISIONS D7): upload-copy via a native dialog with chunked large-file
 * copies + progress events, and Recycle Bin deletes.
 *
 * Channels (all behind handleAppIpc's sender-origin gate + Zod):
 *   fs:copy-selected  ({destDir, strategy}) → {ok, copied, error?}
 *   fs:trash          ({absPath})             → {ok, error?}
 *   event fs:event    ({type:'copy-progress', name, loaded, total})
 */
import { dialog, shell, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

type HandleFn = (channel: string, handler: (event: any, ...args: any[]) => any) => void;

const copySchema = z.object({
  destDir: z.string().min(1).max(1000),
  strategy: z.enum(["keep", "replace"]).catch("keep"),
});
const trashSchema = z.object({
  absPath: z.string().min(1).max(1000),
});

const LARGE_FILE_BYTES = 50 * 1024 * 1024;
const CHUNK_BYTES = 8 * 1024 * 1024;

/** Free dest name ("keep both" strategy): name.ext, name (1).ext, … */
function freeDestName(dir: string, base: string): string {
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let candidate = path.join(dir, base);
  let n = 0;
  while (fs.existsSync(candidate)) {
    n += 1;
    candidate = path.join(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

export function registerFsOps(getMainWindow: () => BrowserWindow | null, handleAppIpc: HandleFn): void {
  handleAppIpc("fs:copy-selected", async (_e: unknown, raw: unknown) => {
    const parsed = copySchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid copy request" };
    const { destDir } = parsed.data;
    let strategy = parsed.data.strategy;

    try {
      const st = await fs.promises.stat(destDir);
      if (!st.isDirectory()) return { ok: false, error: "Upload folder is not a folder" };
    } catch {
      return { ok: false, error: "Upload folder does not exist" };
    }

    const win = getMainWindow();
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      title: "Select files to upload",
      properties: ["openFile", "multiSelections"],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: true, copied: [] };
    }

    const copied: Array<{ name: string; dest: string; renamed: boolean; replaced: boolean }> = [];
    const emit = (payload: Record<string, unknown>) => {
      try { win?.webContents.send("fs:event", payload); } catch {}
    };

    // Collision prompt (replace / keep both / cancel) — BEFORE anything is
    // written. Only when a same-name file actually sits in the destination.
    const pickedNames = picked.filePaths.map((s) => path.basename(s));
    const collisions = pickedNames.filter((n) => fs.existsSync(path.join(destDir, n)));
    if (collisions.length > 0) {
      const names = collisions.slice(0, 5).join(", ") + (collisions.length > 5 ? ` and ${collisions.length - 5} more` : "");
      const answer = win
        ? await dialog.showMessageBox(win, {
            type: "warning",
            title: "Files already exist",
            message: `${collisions.length} file${collisions.length === 1 ? "" : "s"} already in this folder:\n${names}`,
            detail: "Replace overwrites the existing files. Keep both saves the new ones as “name (1)” next to them.",
            buttons: ["Replace", "Keep both", "Cancel"],
            cancelId: 2,
            defaultId: 0,
          })
        : { response: 1 };
      if (answer.response === 2) return { ok: true, copied: [], error: "cancelled" };
      strategy = answer.response === 0 ? "replace" : "keep";
    }

    for (const src of picked.filePaths) {
      try {
        const base = path.basename(src);
        const srcStat = await fs.promises.stat(src);
        if (!srcStat.isFile()) continue;
        const exists = fs.existsSync(path.join(destDir, base));
        const dest = exists && strategy !== "replace" ? freeDestName(destDir, base) : path.join(destDir, base);

        if (srcStat.size > LARGE_FILE_BYTES) {
          // Streamed copy so a big file never blocks the main loop and
          // progress can be reported.
          const inFd = await fs.promises.open(src, "r");
          const outFd = await fs.promises.open(dest, "w");
          const buf = Buffer.alloc(CHUNK_BYTES);
          let loaded = 0;
          let pos = 0;
          try {
            for (;;) {
              const { bytesRead } = await inFd.read(buf, 0, buf.length, pos);
              if (bytesRead === 0) break;
              await outFd.write(buf, 0, bytesRead, pos);
              pos += bytesRead;
              loaded += bytesRead;
              emit({ type: "copy-progress", name: base, loaded, total: srcStat.size });
            }
          } finally {
            await inFd.close().catch(() => {});
            await outFd.close().catch(() => {});
          }
        } else {
          await fs.promises.copyFile(src, dest);
        }
        copied.push({ name: base, dest, renamed: dest !== path.join(destDir, base), replaced: exists && strategy === "replace" });
      } catch (err) {
        return { ok: false, error: `Copy failed: ${(err as Error)?.message || String(err)}`, copied };
      }
    }
    return { ok: true, copied };
  });

  handleAppIpc("fs:trash", async (_e: unknown, raw: unknown) => {
    const parsed = trashSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid trash request" };
    const { absPath } = parsed.data;
    try {
      if (!(await fs.promises.stat(absPath).catch(() => null))) {
        return { ok: false, error: "File not found" };
      }
      await shell.trashItem(absPath);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || String(err) };
    }
  });
}
