/**
 * prompt-meter.ts — Per-task token meter for the master-prompt system.
 *
 * The compact profile exists to save TPM on the free tier (8k/min NVIDIA):
 * full doctrine on turn 1, ~1/3-size essentials on later/repair turns. This
 * meter makes the saving *visible and verifiable* per task: every model call
 * records its mode, effort, profile, and estimated prompt-token split
 * (system prompt vs conversation context), plus the counterfactual — what
 * the call WOULD have cost if it had always sent the full profile.
 *
 * Renderer-side singleton (the worker runs in the browser), best-effort —
 * metering must never break a task.
 */

export interface PromptCallRecord {
  turn: number;
  /** "full" | "compact" — the profile actually sent */
  profile: "full" | "compact";
  mode: string;
  effort?: string;
  /** Estimated tokens of the system prompt block sent for this call. */
  systemTokens: number;
  /** Estimated tokens of the conversation context (everything else). */
  contextTokens: number;
  /** Counterfactual system size had the FULL profile been sent. */
  fullSystemTokens: number;
  /** MCP tool-schema tokens included in systemTokens (C10 accounting). */
  toolSchemaTokens: number;
  why: string;
  at: number;
}

export interface TaskMeter {
  taskId: string;
  mode: string;
  calls: PromptCallRecord[];
  startedAt: number;
}

const METERS: TaskMeter[] = [];
const MAX_TASKS = 20;

/** Live system-prompt sizes (chars), set once at module init by the builder. */
let FULL_SYSTEM_CHARS = 0;
let COMPACT_SYSTEM_CHARS = 0;

/** Register the actual master-prompt sizes (called once at worker init). */
export function calibratePromptSizes(fullChars: number, compactChars: number): void {
  if (fullChars > 0) FULL_SYSTEM_CHARS = fullChars;
  if (compactChars > 0) COMPACT_SYSTEM_CHARS = compactChars;
}

export function getPromptSizes(): { full: number; compact: number } {
  return { full: FULL_SYSTEM_CHARS, compact: COMPACT_SYSTEM_CHARS };
}

/** Start a fresh meter for a task (drops the oldest if over the cap). */
export function startTaskMeter(taskId: string, mode: string): TaskMeter {
  const meter: TaskMeter = { taskId, mode, calls: [], startedAt: Date.now() };
  METERS.push(meter);
  if (METERS.length > MAX_TASKS) METERS.shift();
  return meter;
}

export interface RecordCallInput {
  taskId: string;
  turn: number;
  profile: "full" | "compact";
  mode: string;
  effort?: string;
  /** Character counts of the message list actually sent. */
  systemChars: number;
  contextChars: number;
  /** MCP tool-schema chars sent with the tools array (C10) — counted into system tokens. */
  toolSchemaChars?: number;
  why: string;
}

export function recordPromptCall(input: RecordCallInput): PromptCallRecord | null {
  try {
    const meter = METERS.find((m) => m.taskId === input.taskId);
    if (!meter) return null;
    // MCP schemas ride with every call's tools array → they belong to the
    // system side of the split (C10), not uncounted overhead.
    const systemChars = input.systemChars + (input.toolSchemaChars ?? 0);
    const record: PromptCallRecord = {
      turn: input.turn,
      profile: input.profile,
      mode: input.mode,
      effort: input.effort,
      systemTokens: charsToTokens(systemChars),
      contextTokens: charsToTokens(input.contextChars),
      fullSystemTokens:
        input.profile === "full"
          ? charsToTokens(systemChars)
          : charsToTokens(FULL_SYSTEM_CHARS || systemChars * 3),
      toolSchemaTokens: charsToTokens(input.toolSchemaChars ?? 0),
      why: input.why,
      at: Date.now(),
    };
    meter.calls.push(record);
    return record;
  } catch {
    return null; // metering never breaks the task
  }
}

function charsToTokens(chars: number): number {
  return Math.ceil((chars || 0) / 4); // matches worker's CHARS_PER_TOKEN
}

export function getTaskMeter(taskId: string): TaskMeter | null {
  return METERS.find((m) => m.taskId === taskId) ?? null;
}

export interface PromptSavings {
  calls: number;
  fullCalls: number;
  compactCalls: number;
  /** Estimated tokens actually spent on system prompts across the task. */
  systemTokensSpent: number;
  /** What full-everywhere would have spent on system prompts. */
  systemTokensFullCounterfactual: number;
  tokensSaved: number;
  savedPct: number;
  contextTokensTotal: number;
  grandTotalActual: number;
  grandTotalCounterfactual: number;
}

/** Aggregate savings for one task. */
export function computeTaskSavings(taskId: string): PromptSavings | null {
  const meter = getTaskMeter(taskId);
  if (!meter || meter.calls.length === 0) return null;
  let systemTokensSpent = 0;
  let systemTokensFull = 0;
  let contextTokensTotal = 0;
  for (const c of meter.calls) {
    systemTokensSpent += c.systemTokens;
    systemTokensFull += c.fullSystemTokens;
    contextTokensTotal += c.contextTokens;
  }
  const tokensSaved = systemTokensFull - systemTokensSpent;
  return {
    calls: meter.calls.length,
    fullCalls: meter.calls.filter((c) => c.profile === "full").length,
    compactCalls: meter.calls.filter((c) => c.profile === "compact").length,
    systemTokensSpent,
    systemTokensFullCounterfactual: systemTokensFull,
    tokensSaved,
    savedPct: systemTokensFull > 0 ? Math.round((tokensSaved / systemTokensFull) * 100) : 0,
    contextTokensTotal,
    grandTotalActual: systemTokensSpent + contextTokensTotal,
    grandTotalCounterfactual: systemTokensFull + contextTokensTotal,
  };
}

/** Human-readable one-line summary for the transcript. */
export function formatSavingsSummary(taskId: string): string {
  const s = computeTaskSavings(taskId);
  if (!s || s.calls === 0) return "";
  if (s.compactCalls === 0) {
    return `Prompt meter: ${s.calls} call(s), all full-profile — ${s.grandTotalActual.toLocaleString()} prompt tokens.`;
  }
  return `Prompt meter: ${s.calls} call(s) — ${s.fullCalls} full + ${s.compactCalls} compact → ${s.tokensSaved.toLocaleString()} tokens saved (${s.savedPct}% of system-prompt cost). Actual ${s.grandTotalActual.toLocaleString()} vs ${s.grandTotalCounterfactual.toLocaleString()} if full-everywhere.`;
}

/** Console.table of every call — for devtools inspection. */
export function logTaskMeter(taskId: string): void {
  try {
    const meter = getTaskMeter(taskId);
    if (!meter || typeof console === "undefined") return;
    const s = computeTaskSavings(taskId);
    console.table(
      meter.calls.map((c) => ({
        turn: c.turn,
        profile: c.profile,
        why: c.why,
        system: c.systemTokens,
        context: c.contextTokens,
        wouldBeFull: c.fullSystemTokens,
      }))
    );
    if (s) console.log(`[prompt-meter] saved ${s.tokensSaved} tokens (${s.savedPct}%) this task`);
  } catch {}
}

/** Most recent task meters, newest first (context-budget dashboard). */
export function getRecentTaskMeters(limit = 10): TaskMeter[] {
  return [...METERS].sort((a, b) => b.startedAt - a.startedAt).slice(0, Math.max(1, limit));
}

// ---------------------------------------------------------------------------
// Transcript-line parsing — lets the UI render the meter summary as a
// designed strip instead of plain italic text.
// ---------------------------------------------------------------------------

/** Exact prefix `formatSavingsSummary` emits — the transcript marker. */
export const PROMPT_METER_MARKER = "Prompt meter:";

export interface MeterLineData {
  calls: number;
  fullCalls: number;
  compactCalls: number;
  /** Tokens actually spent (system + context). */
  actualTokens: number;
  /** Present in the savings variant. */
  savedTokens?: number;
  savedPct?: number;
  counterfactualTokens?: number;
  /** True when the line is the "all full-profile" variant. */
  allFull: boolean;
}

/**
 * Parse a meter summary line (either variant) into structured data.
 * Returns null for anything that isn't a meter line — callers render that
 * as plain text. Tolerant of thousands separators and stray whitespace.
 */
export function parseMeterLine(line: string): MeterLineData | null {
  const text = line.trim();
  if (!text.startsWith(PROMPT_METER_MARKER)) return null;

  const num = (s: string) => Number(s.replace(/[,_\s]/g, ""));

  const callsM = text.match(/^(?:Prompt meter:)\s*([\d,]+)\s*call/);
  if (!callsM) return null;
  const calls = num(callsM[1]);
  if (!Number.isFinite(calls) || calls <= 0) return null;

  // Savings variant: "— 2 full + 1 compact → 12,400 tokens saved (34% ...)"
  const fullM = text.match(/([\d,]+)\s*full\s*\+\s*([\d,]+)\s*compact/);
  const savedM = text.match(/→\s*([\d,]+)\s*tokens? saved/);
  const pctM = text.match(/\(([\d.]+)%/);
  const counterfactualM = text.match(/vs\s+([\d,]+)\s+if full-everywhere/);
  const allFullM = text.match(/all full-profile/);
  // All-full variant: "— 2,509 prompt tokens." · Savings variant: "Actual 8,700 vs …"
  const actualM =
    text.match(/Actual\s+([\d,]+)/) || text.match(/—\s+([\d,]+)\s+prompt tokens/);

  if (fullM && savedM) {
    const fullCalls = num(fullM[1]);
    const compactCalls = num(fullM[2]);
    const savedTokens = num(savedM[1]);
    if (fullCalls + compactCalls !== calls) return null;
    return {
      calls,
      fullCalls,
      compactCalls,
      actualTokens: actualM ? num(actualM[1]) : 0,
      savedTokens,
      savedPct: pctM ? num(pctM[1]) : undefined,
      counterfactualTokens: counterfactualM ? num(counterfactualM[1]) : undefined,
      allFull: false,
    };
  }

  if (allFullM) {
    return {
      calls,
      fullCalls: calls,
      compactCalls: 0,
      actualTokens: actualM ? num(actualM[1]) : 0,
      allFull: true,
    };
  }

  return null;
}

/** Reset everything (tests). */
export function resetPromptMeter(): void {
  METERS.length = 0;
}
