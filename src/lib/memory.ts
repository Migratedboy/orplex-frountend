// memory.ts — The tiny memory API. ALL memory writes go through these
// functions; readers query the same buckets. No lane touches Prisma memory
// tables directly.
//
// Permanent buckets (exactly three):
//   1. Project instructions — orplex.md hierarchy (project-memory.ts)
//   2. Workspace learnings  — evidence-backed facts, scored retrieval (workspace-memory.ts)
//   3. Run / failure ledger — what actually failed and why (run-ledger.ts + failure-memory.ts)
// Ephemeral (exactly one):
//   + Scratchpad — current plan/hypotheses/findings/next, per-task only (scratchpad.ts)
//
// Folded away (no parallel stores): compaction-memory is now workspace-memory
// capture, and semantic-cache is deprecated with zero callers (kept only so its
// own test still compiles) — similar past tasks surface through the workspace-
// learnings bucket + run ledger instead.
//
// Playbooks are NOT folded: `playbook.ts` is a first-class bucket with its own
// Prisma store (the Learning table) and full CRUD (/api/playbook, /[id],
// /capture, and the /playbook page). Only the executor's `playbook_search`
// merges playbooks with learnings; the stores are otherwise independent.

// --- Bucket 2: workspace learnings ---
export {
  rememberFact as remember,
  captureWorkspaceMemories,
  retrieveWorkspaceMemories,
  formatMemoriesForPrompt,
  listMemories,
  forgetMemory,
  extractEvictionFacts,
  captureFromCompaction,
  getWorkspaceKey,
  type RetrievedMemory,
  type MemoryKind,
  type CaptureInput,
} from "./workspace-memory";

// --- Bucket 3: run / failure ledger ---
export {
  recordFailure as record_failure,
  getFailures,
  mergeServerFailures,
  buildFailureDoctrineContext,
  clearFailures,
  type FailureKind,
  type FailureRecord,
} from "./failure-memory";
export {
  postRunToLedger,
  fetchLedgerFailures,
  hydrateFailureMemoryFromLedger,
  buildFinalizePayload,
} from "./run-ledger";

// --- Ephemeral: scratchpad ---
export {
  createScratchpad,
  seedScratchpad,
  updateScratchpadSection as update_scratchpad,
  renderScratchpadBlock,
  isScratchpadEmpty,
  type ScratchpadState,
  type ScratchpadSection,
} from "./scratchpad";

// --- Bucket 1: project instructions ---
export * from "./project-memory";
