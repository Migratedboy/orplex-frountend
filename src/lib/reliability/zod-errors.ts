/**
 * reliability/zod-errors.ts — one formatter for zod failures.
 *
 * Both parseEditOp (edit-ops.ts) and validateToolArgs (tool-args.ts) must
 * turn a ZodError into a single line the model can act on. It lives in its
 * own module so neither of those imports the other (tool-args.ts needs
 * editOpSchema from edit-ops.ts; a shared helper keeps that edge one-way).
 */
import type { z } from "zod";

/** Flatten a ZodError into one readable line: "path: message; path: message". */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
