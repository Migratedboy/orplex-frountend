// scratchpad.ts — The agent's private working memory (Antigravity-style).
//
// What it is: a per-task, model-writable buffer for plan drafts, hypotheses,
// intermediate results, and the single next move. Separate from the user-facing
// transcript (deliverables stay clean) and from durable memory (nothing here
// is a cross-task learning until the server says so).
//
// What it is NOT: thinking blocks (ephemeral stream, compacted away),
// todo_list (rigid checklist with UI), compaction summaries (worker-written),
// workspace/failure memory (server-derived, cross-task).
//
// Budget discipline: hard-capped; truncation keeps section headings and drops
// oldest findings lines first. Env-agnostic (no window/localStorage here —
// persistence lives in the UI layer) so the server executor shares it.

export type ScratchpadSection = "plan" | "hypotheses" | "findings" | "next";

export interface ScratchpadState {
  plan: string;
  hypotheses: string;
  findings: string;
  next: string;
  /** Tool-loop turn that last touched any section. */
  updatedAtTurn: number;
}

/** Total char budget across all sections (~350 tokens — cheap every turn). */
export const SCRATCHPAD_MAX_CHARS = 1500;

export const SCRATCHPAD_SECTIONS: readonly ScratchpadSection[] = [
  "plan",
  "hypotheses",
  "findings",
  "next",
];

export function createScratchpad(): ScratchpadState {
  return { plan: "", hypotheses: "", findings: "", next: "", updatedAtTurn: 0 };
}

/** Seed scaffold so weak models write into structure instead of blank space. */
export function seedScratchpad(task: string): ScratchpadState {
  return {
    plan: `Task: ${task.slice(0, 200)}`,
    hypotheses: "",
    findings: "",
    next: "orient: read/list the relevant files first",
    updatedAtTurn: 0,
  };
}

export function isScratchpadEmpty(s: ScratchpadState): boolean {
  return !s.plan && !s.hypotheses && !s.findings && !s.next;
}

function totalChars(s: ScratchpadState): number {
  return s.plan.length + s.hypotheses.length + s.findings.length + s.next.length;
}

/**
 * Set one section, then enforce the budget: keep headings, drop oldest
 * findings lines first (findings are append-mostly logs), then trim the
 * longest remaining section from its head. Never throws.
 */
export function updateScratchpadSection(
  s: ScratchpadState,
  section: ScratchpadSection,
  content: string,
  turn: number
): ScratchpadState {
  const next: ScratchpadState = {
    ...s,
    [section]: (content || "").slice(0, SCRATCHPAD_MAX_CHARS),
    updatedAtTurn: turn,
  };
  if (totalChars(next) <= SCRATCHPAD_MAX_CHARS) return next;
  // Findings are an append log — oldest lines go first.
  const lines = next.findings.split("\n");
  while (totalChars(next) > SCRATCHPAD_MAX_CHARS && lines.length > 1) {
    lines.shift();
    next.findings = lines.join("\n");
  }
  // Still over: trim the longest remaining section from its head.
  const order: ScratchpadSection[] = ["findings", "hypotheses", "plan", "next"];
  for (const key of order) {
    while (totalChars(next) > SCRATCHPAD_MAX_CHARS && next[key].length > 0) {
      next[key] = next[key].slice(Math.min(next[key].length, 200));
      if (totalChars(next) <= SCRATCHPAD_MAX_CHARS) break;
    }
    if (totalChars(next) <= SCRATCHPAD_MAX_CHARS) break;
  }
  return next;
}

/**
 * Render the per-turn context block. Empty scratchpad renders "" (no tokens
 * spent until the model actually uses it — the seed covers complex tasks).
 */
export function renderScratchpadBlock(s: ScratchpadState): string {
  if (isScratchpadEmpty(s)) return "";
  const part = (name: string, body: string) => (body ? `${name}: ${body}` : "");
  return (
    `<scratchpad>\n` +
    [
      part("plan", s.plan),
      part("hypotheses", s.hypotheses),
      part("findings", s.findings),
      part("next", s.next),
    ]
      .filter(Boolean)
      .join("\n") +
    `\n</scratchpad>`
  );
}

/**
 * Compaction handoff: when the transcript has been summarized away, seed any
 * EMPTY scratchpad sections from the summary so the working memory never
 * regresses below what the model knew before the eviction. Model-authored
 * content is NEVER clobbered — the summary only fills gaps. Returns a new
 * state (pure). Empty summary → unchanged input.
 */
export function seedScratchpadFromSummary(
  s: ScratchpadState,
  summary: string,
  turn: number
): ScratchpadState {
  const text = (summary || "").trim();
  if (!text) return s;
  // Cheap extraction: file-ish paths become findings, the first lines tend to
  // carry the task/plan, and "next" is the model's own business — only marked
  // when entirely unknown.
  const fileLines = text
    .split("\n")
    .filter((l) => /[\w./\\-]+\.(ts|tsx|js|jsx|json|md|py|css|html|prisma)/.test(l))
    .slice(0, 6)
    .join("; ");
  const next: ScratchpadState = {
    ...s,
    updatedAtTurn: Math.max(s.updatedAtTurn, turn),
  };
  let changed = false;
  if (!next.plan) {
    next.plan = text.slice(0, 200);
    changed = true;
  }
  if (!next.findings && fileLines) {
    next.findings = `from compacted context: ${fileLines}`.slice(0, 400);
    changed = true;
  }
  if (!next.next) {
    next.next = `context was compacted at turn ${turn}; orient from the summary block`;
    changed = true;
  }
  return changed ? next : s;
}
