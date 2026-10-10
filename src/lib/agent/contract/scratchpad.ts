// contract/scratchpad.ts — Shared scratchpad contract (Step A).
//
// Single import point for the ephemeral per-task working memory used by BOTH
// execution modes. Re-exports the canonical implementation in
// ../../scratchpad. Lifetime rule (enforced by convention, not code): per-task
// only — never persisted beyond the task, never a cross-task learning.
export {
  SCRATCHPAD_MAX_CHARS,
  SCRATCHPAD_SECTIONS,
  createScratchpad,
  seedScratchpad,
  isScratchpadEmpty,
  updateScratchpadSection,
  renderScratchpadBlock,
  type ScratchpadSection,
  type ScratchpadState,
} from "../../scratchpad";
