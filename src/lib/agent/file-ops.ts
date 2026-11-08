// file-ops.ts — The ONE implementation of "write a file through the audited
// path": record history → write (real FS when a folder is open, else virtual)
// → update counters/memory. background-worker used to carry six near-identical
// copies of this logic (main loop, orchestrated writes, self-review, recheck,
// typecheck-repair, swarm-repair, browser-repair) which drifted independently.

import { recordChange } from "../file-history";
import { serializeWrites } from "../write-queue";
import { locateFirstRange } from "../edit-locate";
import { virtualFS } from "../virtual-fs";
import type { ToolCall } from "../stream-reader";

export interface FileOpsFs {
  readFile: ((path: string) => Promise<string>) | null;
  writeFile: ((path: string, content: string) => Promise<boolean>) | null;
  editFile: ((path: string, oldText: string, newText: string) => Promise<boolean>) | null;
  /** Optional size probe so guards can refuse without whole-file reads */
  statFile?: ((path: string) => Promise<{ size: number } | null>) | null;
  /** Paged read: fetch ONLY a line window from disk (server lane). Returns
   *  null when unsupported; the dispatcher then falls back to whole-file. */
  readPage?: ((path: string, offsetLine: number, limitLines: number) => Promise<{
    text: string; startLine: number; endLine: number; totalLines: number; hasMore: boolean;
  } | null>) | null;
  directoryName: string;
}

export interface FileOpsCounters {
  writtenFiles: Map<string, string>;
  getTotalWrites(): number;
  setTotalWrites(n: number): void;
  setFilesChanged: (n: number) => void;
  bumpStat: (key: "toolCalls") => void;
}

/** Read the current content of a file for history purposes (null when absent). */
async function readCurrent(fs: FileOpsFs, path: string): Promise<string | null> {
  if (!fs.readFile) return null;
  const prev = await fs.readFile(path).catch(() => null);
  return prev !== null && !prev.startsWith("[Error") ? prev : null;
}

/**
 * Post-write verification: re-read the file and make sure it holds exactly
 * what was meant to be written (no partial content, no duplicated blocks
 * from a retried stream, no leftover markers). Data changed by the write is
 * large enough to skip it when the read would be a truncated "head window"
 * (server-lane windowed reads): those writes are guarded up front by the
 * anti-clobber probes instead.
 */
async function verifyWritten(
  fs: FileOpsFs,
  path: string,
  expected: string
): Promise<boolean> {
  if (expected.length > 2_000_000) return true;
  const after = await readCurrent(fs, path);
  // Unreadable (absent, read error, or a stub harness that cannot know the
  // new content) is NOT evidence of a bad write — fs.writeFile already
  // returned true, and a partial write would read back as CONTENT, not as
  // nothing. Failing the write here used to turn every stub-backed lane
  // into "[ERROR] Failed to write" and silently starved writtenFiles.
  if (after === null) return true;
  return after === expected;
}

function bumpWriteCounters(counters: FileOpsCounters, path: string, content: string): void {
  counters.bumpStat("toolCalls");
  counters.setTotalWrites(counters.getTotalWrites() + 1);
  counters.setFilesChanged(counters.getTotalWrites());
  counters.writtenFiles.set(path, content);
}

/**
 * Write (create/overwrite) a file through the audited path.
 * Serialized per path — concurrent writes to the same file queue up in
 * order; different files run in parallel.
 * Returns false when the write itself failed or the on-disk verification
 * found the file does not hold the written content.
 */
export async function writeFileAudited(
  path: string,
  content: string,
  fs: FileOpsFs,
  counters: FileOpsCounters
): Promise<boolean> {
  return serializeWrites([path], async () => {
    let ok = false;
    if (fs.writeFile) {
      const prevContent = await readCurrent(fs, path);
      await recordChange(path, prevContent, content);
      ok = await fs.writeFile(path, content);
      if (ok) ok = await verifyWritten(fs, path, content);
    } else {
      const prevContent = virtualFS.readFile(path);
      await recordChange(path, prevContent, content, false);
      ok = virtualFS.writeFile(path, content);
    }
    if (ok) {
      bumpWriteCounters(counters, path, content);
    }
    return ok;
  });
}

/**
 * Locate `oldText` inside current content: exact indexOf first, then a
 * line-ending-insensitive re-location for the case where an earlier write
 * left the file as CRLF while the model keeps sending \n. Returning the
 * byte-range replacement keeps the effect identical to String.replace.
 */
async function locatedEdit(
  path: string,
  oldText: string,
  newText: string,
  prevContent: string,
  fs: FileOpsFs,
  counters: FileOpsCounters
): Promise<boolean> {
  const range = locateFirstRange(prevContent, oldText);
  if (!range) return false;
  const next = prevContent.slice(0, range.start) + newText + prevContent.slice(range.end);
  await recordChange(path, prevContent, next);
  if (!fs.writeFile) return false;
  let ok = await fs.writeFile(path, next);
  if (ok) ok = await verifyWritten(fs, path, next);
  if (ok) bumpWriteCounters(counters, path, next);
  return ok;
}

/**
 * Edit a file through the audited path. Serialized per path and applied
 * against the file's CURRENT content — each edit re-reads the file inside
 * the lock, so an agent re-editing the same code never applies stale text
 * or corrupts an earlier attempt. When the exact target text is no longer
 * present (line endings changed, target otherwise moved), the region is
 * re-located; if it truly cannot be found the edit fails cleanly and the
 * file is left untouched.
 * Returns false when the edit failed (text not found / no editor).
 */
export async function editFileAudited(
  path: string,
  oldText: string,
  newText: string,
  fs: FileOpsFs,
  counters: FileOpsCounters
): Promise<boolean> {
  if (!fs.editFile) return false;
  const edit = fs.editFile;
  return serializeWrites([path], async () => {
    const prevContent = await readCurrent(fs, path);
    if (prevContent === null) return false;

    if (!prevContent.includes(oldText)) {
      return locatedEdit(path, oldText, newText, prevContent, fs, counters);
    }

    await recordChange(path, prevContent, prevContent.replace(oldText, newText));
    const ok = await edit(path, oldText, newText);
    if (ok) {
      // The in-app edit never returns a computed "next" — read it back so
      // writtenFiles (and the verification) reflect what is actually on disk.
      const after = await readCurrent(fs, path);
      if (after !== null) {
        if (fs.writeFile && !(await verifyWritten(fs, path, after))) return false;
        bumpWriteCounters(counters, path, after);
      } else {
        bumpWriteCounters(counters, path, prevContent.replace(oldText, newText));
      }
    }
    return ok;
  });
}

export interface AppliedWriteResult {
  call: ToolCall;
  kind: "write" | "edit" | "batch";
  path?: string;
  ok: boolean;
}

/**
 * Apply the write/edit/batch_edit calls from a model turn (repair turns,
 * self-review, orchestrated writes). The main tool loop uses its own richer
 * dispatch; everything else funnels here so undo/file-history/counters stay
 * consistent no matter which lane produced the writes.
 */
async function applyModelWrites(
  calls: ToolCall[],
  fs: FileOpsFs,
  counters: FileOpsCounters
): Promise<AppliedWriteResult[]> {
  const results: AppliedWriteResult[] = [];
  for (const call of calls) {
    if (call.name === "write_file" && call.path && call.content !== undefined) {
      const ok = await writeFileAudited(call.path, call.content, fs, counters);
      results.push({ call, kind: "write", path: call.path, ok });
    } else if (call.name === "edit_file" && call.path && call.old_text && call.new_text) {
      const ok = await editFileAudited(call.path, call.old_text, call.new_text, fs, counters);
      results.push({ call, kind: "edit", path: call.path, ok });
    } else if (call.name === "batch_edit" && Array.isArray(call.edits)) {
      let batchOk = true;
      for (const e of call.edits) {
        const ok = await editFileAudited(e.path, e.old_text, e.new_text, fs, counters);
        if (!ok) batchOk = false;
      }
      results.push({ call, kind: "batch", ok: batchOk });
    }
  }
  return results;
}
