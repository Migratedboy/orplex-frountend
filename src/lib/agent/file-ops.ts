// file-ops.ts — The ONE implementation of "write a file through the audited
// path": record history → write (real FS when a folder is open, else virtual)
// → update counters/memory. background-worker used to carry six near-identical
// copies of this logic (main loop, orchestrated writes, self-review, recheck,
// typecheck-repair, swarm-repair, browser-repair) which drifted independently.

import { recordChange } from "../file-history";
import { virtualFS } from "../virtual-fs";
import { invalidateByFileChange } from "../semantic-cache";
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
  return prev && !prev.startsWith("[Error") ? prev : null;
}

/**
 * Write (create/overwrite) a file through the audited path.
 * Returns false when the write itself failed.
 */
export async function writeFileAudited(
  path: string,
  content: string,
  fs: FileOpsFs,
  counters: FileOpsCounters
): Promise<boolean> {
  let ok = false;
  if (fs.writeFile) {
    const prevContent = await readCurrent(fs, path);
    recordChange(path, prevContent, content);
    ok = await fs.writeFile(path, content);
  } else {
    ok = virtualFS.writeFile(path, content);
  }
  if (ok) {
    counters.bumpStat("toolCalls");
    counters.setTotalWrites(counters.getTotalWrites() + 1);
    counters.setFilesChanged(counters.getTotalWrites());
    counters.writtenFiles.set(path, content);
    // A changed file invalidates cached answers derived from its old
    // content — otherwise the semantic cache serves stale hints. The cache
    // must never break a write, so failures are swallowed.
    try { invalidateByFileChange(path); } catch {}
  }
  return ok;
}

/**
 * Edit a file through the audited path. Returns false when the edit failed
 * (text not found / no editor).
 */
export async function editFileAudited(
  path: string,
  oldText: string,
  newText: string,
  fs: FileOpsFs,
  counters: FileOpsCounters
): Promise<boolean> {
  if (!fs.editFile) return false;
  const ok = await fs.editFile(path, oldText, newText);
  if (ok) {
    counters.setTotalWrites(counters.getTotalWrites() + 1);
    counters.setFilesChanged(counters.getTotalWrites());
    if (fs.readFile) {
      const after = await fs.readFile(path).catch(() => null);
      if (after && !after.startsWith("[Error")) counters.writtenFiles.set(path, after);
    }
    try { invalidateByFileChange(path); } catch {}
  }
  return ok;
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
export async function applyModelWrites(
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
