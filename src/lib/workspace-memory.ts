// workspace-memory.ts — FRONTEND TYPE SHIM (physical split).
//
// The real implementation (Prisma writes, embedding generation) is
// backend-owned: backend/src/lib/workspace-memory.ts. The browser-side
// client (src/lib/workspace-memory-client.ts) only needs the INPUT shape to
// POST captures to /api/agent/memory/capture on the backend — so this file
// deliberately contains types only, keeping @prisma/client and the
// @huggingface/transformers embedding stack out of the UI bundle forever.

/** Learnings a completed run is worth persisting (mirrors the backend type). */
export interface CaptureInput {
  workspaceKey: string;
  task: string;
  /** Final written/edited files (path → content optional). */
  writtenFiles: Record<string, unknown>;
  /** Which verification lanes passed for this run. */
  lanes: { typecheck?: string; browser?: string };
  /** The user accepted these; that's a decision worth remembering. */
  acceptedSuggestions?: string[];
  /** The user rejected these; avoid repeating them. */
  rejectedSuggestions?: string[];
  finalStatus: string;
  /** Client transport only: which folder this run wrote to (server recomputes workspaceKey). */
  directoryName?: string;
}
