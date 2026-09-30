// compaction.ts — Summarizing context compaction for the agent loops.
//
// fitMessagesToBudget (background-worker) is lossy truncation: when the
// transcript outgrows the TPM budget it silently DROPS the oldest messages —
// including the agent's own plan, decisions, and what it already tried. That
// is the exact failure Claude Code's summarized compaction exists to prevent,
// and it bites hardest on an 8k-TPM free tier where budgets are tiny.
//
// compactTranscript replaces the "drop oldest" stage: evicted messages become
// one ~400-token summary prepended as a <context_so_far> block. The summary
// call goes through the caller-provided summarizeFn (provider adapter + TPM
// pacer). Every failure path returns null so the caller falls back to plain
// truncation — compaction must never block a task.
//
// Incremental: state (coveredCount + last summary) lets a growing transcript
// summarize ONLY newly evicted messages, merged into the previous summary —
// one bounded call per eviction, not a re-read of all history every turn.

export interface CompactMessage {
  role: string;
  content: string;
}

export interface CompactionState {
  /** How many leading transcript messages are already folded into `summary`. */
  coveredCount: number;
  /** The last accepted <context_so_far> body (without the wrapper). */
  summary: string;
  /** Cheap fingerprint of the covered prefix (content lengths) — detects a replaced transcript. */
  fingerprint: number[];
}

export interface CompactOptions {
  /** Compact only when total tokens exceed this fraction of the budget. */
  triggerFraction?: number;
  /** Token cap for the summary itself. */
  summaryTokenCap?: number;
  /** Minimum messages that must remain verbatim after compaction. */
  keepRecent?: number;
}

export interface CompactResult {
  messages: CompactMessage[];
  evictedCount: number;
  newState: CompactionState;
}

export const DEFAULT_SUMMARY_TOKEN_CAP = 400;
const DEFAULT_TRIGGER_FRACTION = 0.8;
const DEFAULT_KEEP_RECENT = 4;

/** Caller supplies this so this module stays transport-agnostic and testable. */
export type SummarizeFn = (prompt: string, maxTokens: number) => Promise<string>;

/** Stateful per-task compactor returned by createTranscriptCompactor. */
export interface TranscriptCompactor {
  compact: (
    messages: CompactMessage[],
    budgetTokens: number,
    signal?: AbortSignal | null
  ) => Promise<CompactMessage[] | null>;
  /** Drop cached state (new task on a reused worker). */
  reset: () => void;
}

export function estimateCompactTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}

function totalTokens(messages: CompactMessage[]): number {
  return messages.reduce((s, m) => s + estimateCompactTokens(m.content), 0);
}

const SUMMARY_SYSTEM_PROMPT = `You compress a coding-agent transcript into a context block. Output ONLY the block, no preamble. Keep, tersely: (1) the user's original task and any constraints, (2) the agent's plan and its current step, (3) every file path touched and what was done to it, (4) key decisions and WHY, (5) errors hit and what was already tried, (6) anything the user approved or rejected. Maximum density. Never invent facts.`;

const charCapFor = (tokens: number) => tokens * 4;

/**
 * Compact a transcript under budgetTokens by summarizing evicted oldest
 * messages into a single <context_so_far> block. Returns null when nothing
 * needed compacting (caller keeps its input as-is).
 *
 * Guarantees:
 *  - The last `keepRecent` messages (including the anchor-bearing final one)
 *    survive verbatim.
 *  - Any summarizeFn failure → null (caller falls back to truncation).
 *  - With `state` from a previous call, only newly evicted messages are
 *    summarized and merged into the previous block.
 */
export async function compactTranscript(
  messages: CompactMessage[],
  budgetTokens: number,
  summarizeFn: SummarizeFn,
  opts: CompactOptions = {},
  state?: CompactionState
): Promise<CompactResult | null> {
  if (messages.length === 0 || budgetTokens <= 0) return null;

  const triggerFraction = opts.triggerFraction ?? DEFAULT_TRIGGER_FRACTION;
  const summaryTokenCap = opts.summaryTokenCap ?? DEFAULT_SUMMARY_TOKEN_CAP;
  const keepRecent = Math.max(1, opts.keepRecent ?? DEFAULT_KEEP_RECENT);

  const evictableEnd = Math.max(0, messages.length - keepRecent);
  if (evictableEnd < 2) return null; // nothing meaningful to summarize

  const trigger = Math.floor(budgetTokens * triggerFraction);
  if (totalTokens(messages) <= trigger) return null;

  // Evict oldest-first until (summary + remaining) fits the budget.
  let evictCount = 0;
  const fits = (count: number) =>
    totalTokens(messages.slice(count)) + summaryTokenCap <= budgetTokens;
  while (evictCount < evictableEnd && !fits(evictCount)) evictCount++;
  if (evictCount < 2) return null; // barely over trigger — truncation handles it fine

  // Incremental: if the covered prefix is byte-identical to what the state
  // summarized (transcripts are append-only within a task), only the newly
  // evicted tail needs the model. A mismatch (fresh task, edited history)
  // falls back to a full re-summarize of everything evicted.
  const covered = state?.coveredCount ?? 0;
  const prevSummary = state?.summary ?? "";
  const fingerprint = state?.fingerprint ?? [];
  const prefixStable =
    covered > 0 &&
    covered <= evictCount &&
    fingerprint.length === covered &&
    messages
      .slice(0, covered)
      .every((m, i) => m.content.length === fingerprint[i]);

  let prompt: string;
  if (prefixStable && prevSummary) {
    const newTail = messages
      .slice(covered, evictCount)
      .map((m) => `<${m.role}>\n${m.content.slice(0, 6_000)}\n</${m.role}>`)
      .join("\n");
    prompt = `${SUMMARY_SYSTEM_PROMPT}\n\nPrevious summary of earlier messages:\n<summary>\n${prevSummary}\n</summary>\n\nNew messages to fold in:\n${newTail}\n\nOutput the updated summary block only.`;
  } else {
    const body = messages
      .slice(0, evictCount)
      .map((m) => `<${m.role}>\n${m.content.slice(0, 6_000)}\n</${m.role}>`)
      .join("\n");
    prompt = `${SUMMARY_SYSTEM_PROMPT}\n\nTranscript to compress:\n${body}`;
  }

  let summary: string;
  try {
    summary = (await summarizeFn(prompt, summaryTokenCap)).trim();
    if (!summary) return null;
    if (summary.length > charCapFor(summaryTokenCap) * 1.5) {
      // A model that ignored the cap would eat the budget we just freed.
      summary = summary.slice(0, charCapFor(summaryTokenCap) * 1.5) + "\n…[summary truncated]";
    }
  } catch {
    return null; // failsafe: caller falls back to fitMessagesToBudget
  }

  const block: CompactMessage = {
    role: "user",
    content: `<context_so_far>\n${summary}\n</context_so_far>\n(Older transcript was compacted into this summary — ${evictCount} earlier messages. Specifics above are authoritative; re-read files via tools if precision matters.)`,
  };

  return {
    messages: [block, ...messages.slice(evictCount)],
    evictedCount: evictCount,
    newState: {
      coveredCount: evictCount,
      summary,
      fingerprint: messages.slice(0, evictCount).map((m) => m.content.length),
    },
  };
}

/**
 * Stateful compactor for one task/run — holds CompactionState across calls so
 * evictions are incremental. `reset()` must be called when the underlying
 * transcript is replaced (new task on a reused worker).
 */
export function createTranscriptCompactor(summarizeFn: SummarizeFn, opts: CompactOptions = {}) {
  let state: CompactionState = { coveredCount: 0, summary: "", fingerprint: [] };
  return {
    compact: (messages: CompactMessage[], budgetTokens: number, signal?: AbortSignal | null) =>
      signal?.aborted ? Promise.resolve(null) : compactTranscript(messages, budgetTokens, summarizeFn, opts, state).then((r) => {
        if (r) state = r.newState;
        return r ? r.messages : null;
      }),
    reset: () => {
      state = { coveredCount: 0, summary: "", fingerprint: [] };
    },
  };
}
