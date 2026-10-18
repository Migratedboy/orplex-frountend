/**
 * reliability/edit-ops.ts — the structured edit-operation model (plan §8.1,
 * deviation D-3).
 *
 * D-3: `EditOp` is ADDED alongside the existing write tools behind
 * RELIABILITY_EDIT_OPS — write_file/edit_file/batch_edit are not removed or
 * changed by this module (master-prompt rule 4: add new tools alongside,
 * deprecate old ones behind a flag).
 *
 * What this buys over the legacy string tools:
 *  - `expectedHash` — stale-read detection. The legacy path has only an
 *    `old_text` substring precondition and no way to notice the file changed
 *    since it was read.
 *  - `occurrence` — the legacy path uses String.replace, which silently
 *    picks the FIRST match when oldText appears more than once. That silent
 *    pick is the bug; the default here is the strict `exactly_one`.
 *  - `batch` — one atomic unit for applyEditOpsAtomic (atomic-batch.ts), so
 *    master-prompt.ts's "batch_edit for atomic multi-file changes" promise
 *    becomes true for this surface.
 *
 * Batch is deliberately NON-recursive (ops are the base union, never another
 * batch): nesting would make rollback ordering and depth unbounded for no
 * added power — flatten two batches at the call site instead.
 */
import { z } from "zod";
import { formatZodError } from "./zod-errors";

/** The tool name the model calls to submit EditOps (see TOOL_ARG_SCHEMAS). */
export const EDIT_OPS_TOOL_NAME = "apply_edit_ops";

/** A workspace-relative path. Empty paths are never valid. */
const pathField = z.string().min(1, "path must not be empty");

export const createFileSchema = z.object({
  op: z.literal("create_file"),
  path: pathField,
  content: z.string(),
  /** Refuse if the file already exists — a create that must not clobber. */
  expectedAbsence: z.literal(true).optional(),
});

export const replaceTextSchema = z.object({
  op: z.literal("replace_text"),
  path: pathField,
  oldText: z.string().min(1, "oldText must not be empty"),
  newText: z.string(),
  /** Hash of the content the model last read — mismatch ⇒ refuse. */
  expectedHash: z.string().min(1).optional(),
  /**
   * Defaults to "exactly_one": the strictest mode, and the one that fixes the
   * legacy String.replace bug (see module header).
   */
  occurrence: z.enum(["first", "all", "exactly_one"]).optional(),
});

export const insertAtSchema = z.object({
  op: z.literal("insert_at"),
  path: pathField,
  /** 1-based line number; `lines + 1` appends at the end. */
  line: z.number().int().min(1, "line is 1-based"),
  content: z.string(),
  expectedHash: z.string().min(1).optional(),
});

export const deleteFileSchema = z.object({
  op: z.literal("delete_file"),
  path: pathField,
  /** Hash of the file being deleted — refuse if it is not what was read. */
  expectedHash: z.string().min(1).optional(),
});

export const moveFileSchema = z.object({
  op: z.literal("move_file"),
  from: pathField,
  to: pathField,
  /** Hash of the SOURCE content — refuse if the source changed since read. */
  expectedHash: z.string().min(1).optional(),
});

/** The non-batch ops. This is what a batch may contain (no nesting). */
export const editOpBaseSchema = z.union([
  createFileSchema,
  replaceTextSchema,
  insertAtSchema,
  deleteFileSchema,
  moveFileSchema,
]);

export const batchSchema = z.object({
  op: z.literal("batch"),
  ops: z.array(editOpBaseSchema),
});

/** The full discriminated union — the EditOp wire model. */
export const editOpSchema = z.discriminatedUnion("op", [
  createFileSchema,
  replaceTextSchema,
  insertAtSchema,
  deleteFileSchema,
  moveFileSchema,
  batchSchema,
]);

export type CreateFileOp = z.infer<typeof createFileSchema>;
export type ReplaceTextOp = z.infer<typeof replaceTextSchema>;
export type InsertAtOp = z.infer<typeof insertAtSchema>;
export type DeleteFileOp = z.infer<typeof deleteFileSchema>;
export type MoveFileOp = z.infer<typeof moveFileSchema>;
export type BatchOp = z.infer<typeof batchSchema>;
/** Everything a batch is allowed to contain — the union without `batch`. */
export type EditOpBase = z.infer<typeof editOpBaseSchema>;
export type EditOp = z.infer<typeof editOpSchema>;

/**
 * Parse untrusted input (model output) into an EditOp. Never throws: a
 * malformed op returns { ok: false, error } with a one-line reason the caller
 * can hand straight back to the model.
 */
export function parseEditOp(raw: unknown): { ok: true; op: EditOp } | { ok: false; error: string } {
  const parsed = editOpSchema.safeParse(raw);
  if (parsed.success) return { ok: true, op: parsed.data };
  return { ok: false, error: formatZodError(parsed.error) };
}
