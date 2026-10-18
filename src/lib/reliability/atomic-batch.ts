/**
 * reliability/atomic-batch.ts — all-or-nothing application of EditOps
 * (plan §8.2; audit finding "master-prompt promises atomic batch_edit — it is
 * not atomic").
 *
 * The legacy batch_edit loops sequentially with no rollback
 * (native-tools.ts:803-809): when edit 2 of 3 fails, edit 1 stays on disk and
 * the model is told "2 succeeded, 1 failed" — a half-applied batch. This
 * module makes the promise true for the structured surface: apply in order,
 * and on the FIRST failure roll every already-applied op back in reverse
 * order (restore previous content, delete what was created, move what was
 * moved), then report the original failure.
 *
 * The filesystem is injected as EditIO, so the rollback sequencing — the
 * actual thing under test — is provable with an in-memory fake and no disk
 * (see __tests__/atomic-batch.test.ts). It also keeps this module free of
 * node:fs imports, so whoever wires it can back EditIO from ctx.fs on the
 * client lane or the server lane alike.
 *
 * Preconditions enforced here (both absent from the legacy tools):
 *  - `expectedHash` — re-read the file, hash it, refuse on mismatch. Catches
 *    edits built on a stale read (concurrent lane, undo, manual user edit).
 *  - `occurrence: "exactly_one"` — refuses when oldText matches 0 or >1
 *    times. String.replace silently picks the first match today; that silent
 *    pick is the bug this fixes, so it is also the DEFAULT when the field is
 *    omitted (see edit-ops.ts).
 */
import type { EditOp, EditOpBase } from "./edit-ops";
import { contentHash } from "./hash";

/** The injected filesystem. Testable without a real FS by design. */
export interface EditIO {
  /** File content, or null when the file does not exist / cannot be read. */
  readFile(path: string): Promise<string | null>;
  /** True on success. Overwrites an existing file. */
  writeFile(path: string, content: string): Promise<boolean>;
  /** True on success. False when the file could not be removed. */
  deleteFile(path: string): Promise<boolean>;
  /** Move/rename, overwriting `to` if present. True on success. */
  moveFile(from: string, to: string): Promise<boolean>;
  fileExists(path: string): Promise<boolean>;
}

/**
 * One successfully-applied op, with exactly what rollback needs to undo it.
 * For move_file, `path` is the DESTINATION and `previousContent` is what the
 * destination held before the move (null ⇒ it did not exist, so undoing the
 * move is sufficient).
 */
export interface AppliedEntry {
  op: EditOpBase;
  path: string;
  /** `path`'s content before the op; null ⇒ the file did not exist. */
  previousContent: string | null;
}

type ApplyOutcome =
  | { ok: true; entry: AppliedEntry }
  | { ok: false; error: string };

/**
 * Batches are not applied as a nested structure: a batch op is spliced into
 * the sequence so "3 ops, middle one fails" has one obvious order to undo.
 */
function flattenOps(ops: readonly EditOp[]): EditOpBase[] {
  const out: EditOpBase[] = [];
  for (const op of ops) {
    if (op.op === "batch") out.push(...op.ops);
    else out.push(op);
  }
  return out;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** null when OK; otherwise the refusal message. */
function hashMismatch(path: string, actual: string, expected: string | undefined): string | null {
  if (expected === undefined) return null;
  const got = contentHash(actual);
  if (got === expected) return null;
  return (
    `hash mismatch for ${path}: expected ${expected}, file hashes to ${got} — ` +
    `the file changed since it was last read; re-read it before editing`
  );
}

/** Non-overlapping match count, i.e. the number of replacements "all" performs. */
function countMatches(content: string, needle: string): number {
  let count = 0;
  let idx = content.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = content.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * String.replace with a STRING pattern applies $-substitutions in the
 * replacement ("$&" inserts the match). Building the result by slicing keeps
 * newText literal, which is what a model means when it sends text.
 */
function replaceFirst(content: string, needle: string, replacement: string): string {
  const idx = content.indexOf(needle);
  return content.slice(0, idx) + replacement + content.slice(idx + needle.length);
}

function replaceAll(content: string, needle: string, replacement: string): string {
  let out = "";
  let start = 0;
  let idx = content.indexOf(needle);
  while (idx !== -1) {
    out += content.slice(start, idx) + replacement;
    start = idx + needle.length;
    idx = content.indexOf(needle, start);
  }
  return out + content.slice(start);
}

async function applyOne(op: EditOpBase, io: EditIO): Promise<ApplyOutcome> {
  switch (op.op) {
    case "create_file": {
      const exists = await io.fileExists(op.path);
      if (op.expectedAbsence && exists) {
        return { ok: false, error: `create_file refused: ${op.path} already exists (expectedAbsence)` };
      }
      let previous: string | null = null;
      if (exists) {
        previous = await io.readFile(op.path);
        if (previous === null) {
          return { ok: false, error: `create_file failed: ${op.path} exists but could not be read for rollback` };
        }
      }
      const wrote = await io.writeFile(op.path, op.content);
      if (!wrote) return { ok: false, error: `create_file failed: could not write ${op.path}` };
      return { ok: true, entry: { op, path: op.path, previousContent: previous } };
    }

    case "replace_text": {
      const current = await io.readFile(op.path);
      if (current === null) return { ok: false, error: `replace_text failed: ${op.path} not found` };
      const mismatch = hashMismatch(op.path, current, op.expectedHash);
      if (mismatch) return { ok: false, error: mismatch };

      const mode = op.occurrence ?? "exactly_one";
      const matches = countMatches(current, op.oldText);
      if (matches === 0) {
        return { ok: false, error: `replace_text failed: oldText not found in ${op.path}` };
      }
      if (mode === "exactly_one" && matches > 1) {
        return {
          ok: false,
          error:
            `replace_text refused: oldText matches ${matches} times in ${op.path}, and occurrence ` +
            `"exactly_one" requires exactly 1 — narrow oldText or set occurrence:"all"`,
        };
      }
      const next =
        mode === "all"
          ? replaceAll(current, op.oldText, op.newText)
          : replaceFirst(current, op.oldText, op.newText);
      const wrote = await io.writeFile(op.path, next);
      if (!wrote) return { ok: false, error: `replace_text failed: could not write ${op.path}` };
      return { ok: true, entry: { op, path: op.path, previousContent: current } };
    }

    case "insert_at": {
      const current = await io.readFile(op.path);
      if (current === null) return { ok: false, error: `insert_at failed: ${op.path} not found` };
      const mismatch = hashMismatch(op.path, current, op.expectedHash);
      if (mismatch) return { ok: false, error: mismatch };

      let next: string;
      if (current === "") {
        if (op.line !== 1) {
          return { ok: false, error: `insert_at failed: line ${op.line} out of range (file is empty; valid line: 1)` };
        }
        next = op.content;
      } else {
        const lines = current.split("\n");
        if (op.line > lines.length + 1) {
          return {
            ok: false,
            error: `insert_at failed: line ${op.line} out of range (file has ${lines.length} line(s); valid 1..${lines.length + 1})`,
          };
        }
        const inserted = op.content.split("\n");
        next = [...lines.slice(0, op.line - 1), ...inserted, ...lines.slice(op.line - 1)].join("\n");
      }
      const wrote = await io.writeFile(op.path, next);
      if (!wrote) return { ok: false, error: `insert_at failed: could not write ${op.path}` };
      return { ok: true, entry: { op, path: op.path, previousContent: current } };
    }

    case "delete_file": {
      const current = await io.readFile(op.path);
      if (current === null) return { ok: false, error: `delete_file failed: ${op.path} not found` };
      const mismatch = hashMismatch(op.path, current, op.expectedHash);
      if (mismatch) return { ok: false, error: mismatch };
      const removed = await io.deleteFile(op.path);
      if (!removed) return { ok: false, error: `delete_file failed: could not delete ${op.path}` };
      return { ok: true, entry: { op, path: op.path, previousContent: current } };
    }

    case "move_file": {
      const source = await io.readFile(op.from);
      if (source === null) return { ok: false, error: `move_file failed: source ${op.from} not found` };
      const mismatch = hashMismatch(op.from, source, op.expectedHash);
      if (mismatch) return { ok: false, error: mismatch };

      let destinationPrevious: string | null = null;
      if (await io.fileExists(op.to)) {
        destinationPrevious = await io.readFile(op.to);
        if (destinationPrevious === null) {
          return { ok: false, error: `move_file failed: destination ${op.to} exists but could not be read for rollback` };
        }
      }
      const moved = await io.moveFile(op.from, op.to);
      if (!moved) return { ok: false, error: `move_file failed: could not move ${op.from} to ${op.to}` };
      return { ok: true, entry: { op, path: op.to, previousContent: destinationPrevious } };
    }
  }
}

interface RollbackResult {
  /** Entries undone successfully, in the order they were undone (reverse of application). */
  done: AppliedEntry[];
  /** Per-entry rollback failures — an incomplete rollback must be REPORTED, not swallowed. */
  errors: string[];
}

async function rollback(applied: readonly AppliedEntry[], io: EditIO): Promise<RollbackResult> {
  const done: AppliedEntry[] = [];
  const errors: string[] = [];

  for (let i = applied.length - 1; i >= 0; i--) {
    const entry = applied[i];
    try {
      if (entry.op.op === "move_file") {
        // Undo the move first; only then restore what the destination held.
        const movedBack = await io.moveFile(entry.op.to, entry.op.from);
        if (!movedBack) {
          errors.push(`could not move ${entry.op.to} back to ${entry.op.from}`);
          continue;
        }
        if (entry.previousContent !== null) {
          const restored = await io.writeFile(entry.op.to, entry.previousContent);
          if (!restored) {
            errors.push(`could not restore ${entry.op.to} after moving back`);
            continue;
          }
        }
        done.push(entry);
        continue;
      }

      if (entry.previousContent === null) {
        // The op created this file — undoing it means it must not exist.
        const removed = await io.deleteFile(entry.path);
        if (!removed) {
          errors.push(`could not delete created file ${entry.path}`);
          continue;
        }
      } else {
        const restored = await io.writeFile(entry.path, entry.previousContent);
        if (!restored) {
          errors.push(`could not restore ${entry.path}`);
          continue;
        }
      }
      done.push(entry);
    } catch (e) {
      errors.push(`${entry.op.op} rollback threw: ${errorText(e)}`);
    }
  }

  return { done, errors };
}

/**
 * Apply `ops` as one atomic unit: either every op lands, or none do.
 *
 * On the first failure, every already-applied op is rolled back in reverse
 * order and the result is { ok: false, error, rolledBack }. `error` names the
 * failing op, its 1-based position, and any rollback shortfall — a rollback
 * that could not complete is stated, never silently absorbed, because a
 * partial rollback reported as clean is the same dishonesty as a half-batch
 * reported as success.
 */
export async function applyEditOpsAtomic(
  ops: EditOp[],
  io: EditIO,
): Promise<
  { ok: true; applied: AppliedEntry[] } | { ok: false; error: string; rolledBack: AppliedEntry[] }
> {
  const flat = flattenOps(ops);
  const applied: AppliedEntry[] = [];

  for (const op of flat) {
    let outcome: ApplyOutcome;
    try {
      outcome = await applyOne(op, io);
    } catch (e) {
      outcome = { ok: false, error: `${op.op} threw: ${errorText(e)}` };
    }

    if (!outcome.ok) {
      const rb = await rollback(applied, io);
      let error =
        `batch aborted: ${outcome.error} (op ${applied.length + 1} of ${flat.length})`;
      if (rb.done.length > 0) {
        error += ` — rolled back ${rb.done.length} earlier op(s)`;
      }
      if (rb.errors.length > 0) {
        error += `; ROLLBACK INCOMPLETE: ${rb.errors.join("; ")}`;
      }
      return { ok: false, error, rolledBack: rb.done };
    }

    applied.push(outcome.entry);
  }

  return { ok: true, applied };
}
