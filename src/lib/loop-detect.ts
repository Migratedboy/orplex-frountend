// Streak-based tool-loop detection for the agent loops.
//
// Four signals, all O(1) per turn, all measured as IN-A-ROW streaks (the
// contract MAX_SAME_TOOL always claimed but the old cumulative counter did
// not honor):
//
//   1. Identical call re-sent — same tool + same args, 3x in a row.
//      Catches weak-model re-emission (the classic gpt-oss loop) at the
//      cheapest possible moment: the check runs BEFORE dispatch, so the
//      3rd duplicate never executes.
//   2. Same target, noisy args — the same object (file window, query,
//      command, URL, tool) acted on 4x in a row even when surrounding args
//      differ. Catches "re-read the same file with a different limit" and
//      "re-run the same search with a different page size", which exact
//      fingerprinting misses. Advancing read offsets are a DIFFERENT target
//      (paging through a file is progress, not a loop).
//   3. Identical multi-call turn — the whole call set repeated 3 turns in a
//      row (e.g. [read A, read B] forever). Single-call turns are signal 1's
//      job; this exists because alternating A/B never tripped anything.
//   4. Same state-changing tool every turn — 5 turns in a row.
//      Read-only tools are exempt: exploring 10 files in a row is normal
//      progress (and duplicate reads are already served from cache by the
//      dispatcher), so only tools that change state or cost real money
//      count. Read turns neither extend nor reset the streak — a
//      write→read→write→read ping-pong still counts toward the cap.
//
// A false trip costs one strategy-change directive (counters reset when the
// model complies); a missed trip burns the TPM window to the hard turn cap.
// Bias: detect.

export const MAX_SAME_TOOL = 5; // same state-changing tool, every turn, this many turns in a row
export const MAX_SAME_CALL = 3; // identical call (same tool + same args) this many times in a row
export const MAX_SAME_TARGET = 4; // same object (path window / query / command / URL) this many times in a row
export const MAX_SAME_TURN = 3; // identical multi-call turn this many turns in a row

// ── Phase 5 extension constants (oscillation / progress / budget / denylist) ──
/** Signatures kept for oscillation detection (bounded so state cannot grow). */
export const OSCILLATION_HISTORY_LIMIT = 20;
/** Smallest repeating pattern oscillation looks for (A,B,A,B → period 2). */
export const OSCILLATION_MIN_PERIOD = 2;
/** Largest repeating pattern oscillation looks for (A,B,C,A,B,C → period 3). */
export const OSCILLATION_MAX_PERIOD = 3;
/** Full periods required before a pattern counts (2×period signatures). */
export const OSCILLATION_MIN_PERIODS = 2;
/** Identical (filesHash, gateFingerprint) snapshots before "no progress" trips. */
export const PROGRESS_STALL_STEPS = 5;
/** Snapshots retained for debugging/UI (the stall counter itself is O(1)). */
export const STEP_SNAPSHOT_LIMIT = 20;
/** Wall-clock budget for one run: 15 minutes. */
export const BUDGET_MAX_WALL_MS = 15 * 60 * 1000;
/** Token budget for one run: 200k tokens (provider-agnostic estimate). */
export const BUDGET_MAX_TOKENS = 200_000;
/** The same (tool, args) failing this many times → refused outright forever. */
export const HARD_DENY_AFTER = 3;

// Read-only tools: exempt from the same-tool streak (never extend, never
// reset). Everything else — writes, commands, browser interactions,
// searches with side effects, scratchpad/todo spam — counts.
// Exported: the single read-only set shared via agent/contract (no rival sets).
export const READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_files",
  "search_code",
  "code_search",
  "web_search",
  "browser_read",
  "browser_find",
  "browser_tabs",
  "browser_network",
  "browser_console",
  "browser_wait_for",
  "browser_screenshot",
  "take_screenshot",
]);

export interface LoopStreaks {
  lastToolName: string | null;
  toolNameStreak: number;
  lastCallFp: string | null;
  callFpStreak: number;
  lastTargetKey: string | null;
  targetStreak: number;
  lastTurnFp: string | null;
  turnFpStreak: number;
  // ── Phase 5 extensions (loop-guard.ts) — additive; the four streak signals
  // above never read these fields, so existing behaviour is unchanged. ──────
  /** Last N normalized call signatures, for A,B,A,B oscillation detection. */
  oscillationHistory: string[];
  /** Per-step workspace/gate snapshots, for no-progress detection (R5). */
  stepSnapshots: Array<{ step: number; filesHash: string; gateFingerprint: string }>;
  /** Consecutive steps with no files-hash AND gate-fingerprint change. */
  stepsWithoutProgress: number;
  /** Cumulative token/wall-clock budget for the run (R6). */
  budget: { startedAt: number; tokenEstimate: number; maxWallMs: number; maxTokens: number };
  /** Normalized-signature → consecutive-failure count, for the hard denylist. */
  callFailureCounts: Map<string, number>;
}

export function createLoopStreaks(): LoopStreaks {
  return {
    lastToolName: null,
    toolNameStreak: 0,
    lastCallFp: null,
    callFpStreak: 0,
    lastTargetKey: null,
    targetStreak: 0,
    lastTurnFp: null,
    turnFpStreak: 0,
    oscillationHistory: [],
    stepSnapshots: [],
    stepsWithoutProgress: 0,
    budget: {
      startedAt: Date.now(),
      tokenEstimate: 0,
      maxWallMs: BUDGET_MAX_WALL_MS,
      maxTokens: BUDGET_MAX_TOKENS,
    },
    callFailureCounts: new Map(),
  };
}

/**
 * Stable call key: same tool + same args regardless of object key order.
 * JSON.stringify with a sorted key list — nested values keep their source
 * order, which is deterministic for args parsed from the same wire JSON.
 */
export function stableCallKey<T extends { name?: string }>(call: T): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(call).sort()) sorted[k] = (call as Record<string, unknown>)[k];
  return `${call.name ?? "?"}|${JSON.stringify(sorted)}`;
}

// ── target identity (signal 2) ──────────────────────────────────────────────

export interface CallTarget {
  /** Stable identity — compared across consecutive calls. */
  key: string;
  /** Human-readable object, safe to surface in prompts and UI notes. */
  label: string;
}

  function str(v: unknown): string {
    return typeof v === "string" ? v : "";
  }

  /**
   * Collapse the spellings of "the workspace root" to one identity.
   *
   * The directory walk treats "", ".", "/", "./" and "src/../" as the same
   * tree, so a model alternating between them is making no progress — which is
   * exactly what happened when it looped on an empty workspace. Resolves "."
   * and ".." segments so the key reflects the tree that is actually walked.
   */
  function normalizeDirPath(p: string): string {
    const raw = (p || "").trim().replace(/\\/g, "/");
    if (raw === "" || raw === "." || raw === "/") return ".";
    const out: string[] = [];
    for (const seg of raw.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        out.pop();
        continue;
      }
      out.push(seg);
    }
    return out.length === 0 ? "." : out.join("/");
  }

function norm(v: unknown): string {
  return String(v ?? "").trim().replace(/\s+/g, " ").slice(0, 160);
}

/**
 * Content fingerprint for write/edit targets: length + a short prefix. A
 * genuinely different edit has a different tag; the identical rewrite (or a
 * content-free repeat) collides — which is exactly the loop we want.
 */
function contentTag(v: unknown): string {
  if (typeof v !== "string") return "";
  return `#${v.length}:${v.slice(0, 48)}`;
}

/**
 * The object a call acts on — or null for calls whose "object" is really
 * their free-form payload (scratchpad sections, todo items, selectors). Some
 * tools stay null on purpose: signal 1 and signal 4 still cover them, while
 * a target key would false-trip on legitimate variation.
 */
export function callTarget<T extends { name?: string }>(call: T): CallTarget | null {
  const name = call.name;
  if (!name) return null;
  const a = call as unknown as Record<string, unknown>;
  const path = str(a.path) || str(a.file);
  const offset = a.offset === undefined ? 0 : Number(a.offset) || 0;

  switch (name) {
    case "list_files": {
      // list_files had NO case here, so callTarget fell through to `default`
      // and returned null. Combined with its READ_ONLY_TOOLS membership (which
      // exempts it from the single-tool-streak signal), NOTHING could catch a
      // model repeatedly listing the same empty workspace — observed live as
      // list_files(), list_files({path:"."}), list_files({path:"/"}) in a row
      // against a 120-turn ceiling.
      //
      // Normalise the path so those spellings collapse to ONE target: they all
      // mean "the workspace root", and the directory walk normalises them
      // identically, so they are not progress. The "successively deeper
      // directory" escape still works, which is the legitimate descent.
      const norm = normalizeDirPath(path);
      return { key: `list|${norm}`, label: `path "${norm}"` };
    }
    case "read_file": {
      if (!path) return null;
      // Offset is part of the identity: paging forward is progress; re-reading
      // the same window forever is the loop.
      return {
        key: `read|${path}|${offset}`,
        label: `path "${path}"${offset ? ` from line ${offset}` : ""}`,
      };
    }
    case "write_file":
    case "write_file_chunk": {
      if (!path) return null;
      return { key: `write|${path}|${contentTag(a.content)}`, label: `path "${path}"` };
    }
    case "edit_file": {
      if (!path) return null;
      return { key: `edit|${path}|${contentTag(a.old_text)}|${contentTag(a.new_text)}`, label: `path "${path}"` };
    }
    case "batch_edit": {
      const edits = Array.isArray(a.edits) ? (a.edits as Array<Record<string, unknown>>) : [];
      const p = str(edits[0]?.path);
      return p ? { key: `batch|${edits.length}|${p}`, label: `path "${p}"` } : null;
    }
    case "search_code":
    case "code_search": {
      const q = norm(a.query ?? a.pattern);
      return q ? { key: `search|${q}`, label: `query "${q}"` } : null;
    }
    case "web_search": {
      const q = norm(a.query);
      return q ? { key: `web|${q}`, label: `query "${q}"` } : null;
    }
    case "run_command": {
      const cmd = norm(a.command);
      return cmd ? { key: `cmd|${cmd}`, label: `command "${cmd.slice(0, 80)}"` } : null;
    }
    case "browser_navigate":
    case "preview_browser": {
      const u = norm(a.url);
      return u ? { key: `url|${u}`, label: `url "${u.slice(0, 80)}"` } : null;
    }
    case "mcp_call": {
      const s = norm(a.serverId ?? a.server);
      const t = norm(a.tool);
      return s || t ? { key: `mcp|${s}|${t}`, label: `tool "${s}${t ? "." + t : ""}"` } : null;
    }
    default: {
      // Direct mcp__<server>__<tool> calls: the tool itself is the target —
      // varying arguments on the same tool 4x in a row is a stuck retry.
      if (name.startsWith("mcp__")) {
        return { key: `mcptool|${name}`, label: `tool "${name}"` };
      }
      return null;
    }
  }
}

export interface LoopVerdict {
  loop: boolean;
  reason: string | null;
  /** Tool the trip was detected on (when the signal is tool-specific). */
  callName?: string;
  /** Human-readable target of the repeated call (signal 2 only). */
  target?: string;
}

/**
 * Record one turn's tool calls and report whether the loop should stop.
 * Mutates `streaks` in place; reset with Object.assign(streaks, createLoopStreaks()).
 */
export function trackToolTurn<T extends { name?: string }>(
  streaks: LoopStreaks,
  calls: ReadonlyArray<T>
): LoopVerdict {
  // Signal 1 — identical call re-sent, in a row (counted across turns and
  // within a turn: [A, A, A] in one message trips immediately).
  for (const call of calls) {
    const fp = stableCallKey(call);
    if (fp === streaks.lastCallFp) {
      streaks.callFpStreak++;
    } else {
      streaks.lastCallFp = fp;
      streaks.callFpStreak = 1;
    }
    if (streaks.callFpStreak >= MAX_SAME_CALL) {
      return {
        loop: true,
        reason: `Looping on ${call.name ?? "call"} (identical call ${streaks.callFpStreak}x in a row)`,
        callName: call.name,
      };
    }
  }

  // Signal 2 — same target, noisy args (exact fingerprint missed it).
  for (const call of calls) {
    const target = callTarget(call);
    if (!target) continue;
    if (target.key === streaks.lastTargetKey) {
      streaks.targetStreak++;
    } else {
      streaks.lastTargetKey = target.key;
      streaks.targetStreak = 1;
    }
    if (streaks.targetStreak >= MAX_SAME_TARGET) {
      return {
        loop: true,
        reason: `Looping on ${call.name ?? "call"} (same target ${streaks.targetStreak}x in a row: ${target.label})`,
        callName: call.name,
        target: target.label,
      };
    }
  }

  // Signal 3 — the identical multi-call turn, repeated. Single-call turns
  // are signal 1's job, so this only engages for 2+ call turns.
  if (calls.length >= 2) {
    const turnFp = calls.map((c) => stableCallKey(c)).sort().join("||");
    if (turnFp === streaks.lastTurnFp) {
      streaks.turnFpStreak++;
    } else {
      streaks.lastTurnFp = turnFp;
      streaks.turnFpStreak = 1;
    }
    if (streaks.turnFpStreak >= MAX_SAME_TURN) {
      return {
        loop: true,
        reason: `Looping on the same ${calls.length}-call sequence (${streaks.turnFpStreak}x in a row: ${calls
          .map((c) => c.name ?? "?")
          .join(", ")})`,
      };
    }
  } else {
    streaks.lastTurnFp = null;
    streaks.turnFpStreak = 0;
  }

  // Signal 4 — one state-changing tool every turn, in a row. A turn only
  // participates if it is single-tool; mixed turns reset (variety = progress).
  const firstName = calls[0]?.name ?? null;
  const singleToolTurn = firstName !== null && calls.every((c) => c.name === firstName);
  if (singleToolTurn && !READ_ONLY_TOOLS.has(firstName!)) {
    if (firstName === streaks.lastToolName) {
      streaks.toolNameStreak++;
    } else {
      streaks.lastToolName = firstName;
      streaks.toolNameStreak = 1;
    }
    if (streaks.toolNameStreak >= MAX_SAME_TOOL) {
      return {
        loop: true,
        reason: `Looping on ${streaks.lastToolName} (${streaks.toolNameStreak}x in a row)`,
        callName: streaks.lastToolName ?? undefined,
      };
    }
  } else if (!singleToolTurn) {
    streaks.lastToolName = null;
    streaks.toolNameStreak = 0;
  }

  return { loop: false, reason: null };
}

/**
 * The strategy-change message injected when a loop trips. Carries the actual
 * evidence — the repeated call plus the last tool result — and closes the
 * two escape hatches weak models use: re-sending the same call, and claiming
 * progress that no tool result supports. Both agent loops inject this exact
 * text, so behavior is identical client- and server-side.
 */
export function buildLoopBreakDirective(verdict: LoopVerdict, lastToolResults?: string): string {
  const evidence = (lastToolResults ?? "").trim().replace(/\s+/g, " ").slice(0, 700);
  const lines = [
    `[LOOP BREAK] ${verdict.reason ?? "You are repeating the same action"}. That call will not run again unchanged.`,
    evidence ? `Your last tool result was: ${evidence}` : "",
    `Choose exactly ONE path:`,
    `1) Take a DIFFERENT action that can make real progress — a different file/window, a different command, or an edit to what you already have.`,
    `2) If you are blocked, STOP and state the blocker plainly: what you tried, the exact error, and what the user must do next.`,
    `Ground every claim in tool results from THIS task: a file counts as changed only when a write/edit call returned success, and never invent output you did not receive.`,
  ];
  return lines.filter(Boolean).join("\n");
}

// ════════════════════════════════════════════════════════════════════════════
// Phase 5 extensions — oscillation (R3), no-progress (R5), budget (R6),
// hard (tool,args) denylist and the 5-rung intervention ladder.
//
// Everything below is ADDITIVE: the four streak signals above never read this
// state, so existing behaviour is byte-identical. The extended signals are
// opt-in per turn (each caller invokes the track* fn it needs) and gated by
// reliabilityLoopGuardExtendedEnabled() at the wiring site.
// ════════════════════════════════════════════════════════════════════════════

// ── R3: oscillation (A,B,A,B) ──────────────────────────────────────────────

/** Arg keys that never change call identity (paging, clocks, request ids). */
const VOLATILE_ARG_KEYS = new Set([
  "offset",
  "limit",
  "line",
  "lines",
  "page",
  "cursor",
  "timestamp",
  "ts",
  "now",
  "requestId",
  "request_id",
  "nonce",
  "uuid",
  "startedAt",
]);

/** Strip volatile VALUE patterns: uuids, timestamps, line/position numbers. */
function stripVolatileText(s: string): string {
  return s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/\b1\d{12}\b/g, "<ts>")
    .replace(/\bline\s+\d+(?::\d+)?\b/gi, "line <n>")
    .replace(/\brow\s+\d+(?::\d+)?\b/gi, "row <n>")
    .replace(/:\d+:\d+(?::\d+)?\b/g, ":<pos>");
}

function stripVolatileDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatileDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_ARG_KEYS.has(k)) continue;
      out[k] = stripVolatileDeep(v);
    }
    return out;
  }
  if (typeof value === "string") return stripVolatileText(value);
  return value;
}

/**
 * Stable call signature with volatile parts (line numbers, offsets, limit,
 * timestamps, uuids) stripped, so two calls that differ ONLY in noise share a
 * signature. Format is `tool|normalizedArgs` — the same key shape the hard
 * denylist uses. Sorted keys keep it order-independent (like stableCallKey).
 */
export function normalizeCallSignature(name: string, args: Record<string, unknown>): string {
  const normalized = stripVolatileDeep(args) as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(normalized).sort()) sorted[k] = normalized[k];
  return `${name}|${JSON.stringify(sorted)}`;
}

/**
 * Record one call signature and report whether the recent tail repeats a
 * period-2 or period-3 pattern (R3). A,B,A,B trips at the 4th signature;
 * A,B,C,A,B,C at the 6th. History is bounded to OSCILLATION_HISTORY_LIMIT.
 * Purely additive — callers invoke this alongside (not inside) trackToolTurn.
 */
export function trackOscillation(
  streaks: LoopStreaks,
  signature: string
): { oscillating: boolean; period?: number } {
  streaks.oscillationHistory.push(signature);
  if (streaks.oscillationHistory.length > OSCILLATION_HISTORY_LIMIT) {
    streaks.oscillationHistory.splice(0, streaks.oscillationHistory.length - OSCILLATION_HISTORY_LIMIT);
  }
  const h = streaks.oscillationHistory;
  for (let period = OSCILLATION_MIN_PERIOD; period <= OSCILLATION_MAX_PERIOD; period++) {
    const need = period * OSCILLATION_MIN_PERIODS;
    if (h.length < need) continue;
    const tail = h.slice(h.length - need);
    let repeating = true;
    for (let i = 0; i < need; i++) {
      if (tail[i] !== tail[i % period]) {
        repeating = false;
        break;
      }
    }
    if (repeating) return { oscillating: true, period };
  }
  return { oscillating: false };
}

// ── R5: no-progress over N steps ───────────────────────────────────────────

/**
 * Record one step's workspace hash and gate fingerprint. The step counts as
 * progress only when EITHER changed from the previous snapshot; when both are
 * unchanged the no-progress counter increments. The FIRST snapshot seeds the
 * counter at 1 (a run starts without a known green state), so
 * PROGRESS_STALL_STEPS identical snapshots trip `stalled`.
 */
export function trackProgress(
  streaks: LoopStreaks,
  step: number,
  filesHash: string,
  gateFingerprint: string
): { stalled: boolean; stepsWithoutProgress: number } {
  const prev = streaks.stepSnapshots[streaks.stepSnapshots.length - 1];
  if (prev && prev.filesHash === filesHash && prev.gateFingerprint === gateFingerprint) {
    streaks.stepsWithoutProgress++;
  } else {
    streaks.stepsWithoutProgress = 1;
  }
  streaks.stepSnapshots.push({ step, filesHash, gateFingerprint });
  if (streaks.stepSnapshots.length > STEP_SNAPSHOT_LIMIT) {
    streaks.stepSnapshots.splice(0, streaks.stepSnapshots.length - STEP_SNAPSHOT_LIMIT);
  }
  return {
    stalled: streaks.stepsWithoutProgress >= PROGRESS_STALL_STEPS,
    stepsWithoutProgress: streaks.stepsWithoutProgress,
  };
}

// ── R6: token / wall-clock budget ──────────────────────────────────────────

/**
 * Add this turn's estimated token spend to the run budget. `exceeded` turns
 * the run's directive into a hard stop — the model has burnt the budget and
 * must summarize and hand back, not keep iterating.
 */
export function recordBudget(
  streaks: LoopStreaks,
  tokenDelta: number
): { exceeded: boolean; reason?: string } {
  if (streaks.budget.startedAt === 0) streaks.budget.startedAt = Date.now();
  streaks.budget.tokenEstimate += Math.max(0, tokenDelta);
  if (streaks.budget.tokenEstimate > streaks.budget.maxTokens) {
    return {
      exceeded: true,
      reason: `Token budget exceeded (${streaks.budget.tokenEstimate} > ${streaks.budget.maxTokens})`,
    };
  }
  return { exceeded: false };
}

/** True once the run has been alive longer than budget.maxWallMs. */
export function checkWallClock(streaks: LoopStreaks): { exceeded: boolean } {
  if (streaks.budget.startedAt === 0) {
    streaks.budget.startedAt = Date.now();
    return { exceeded: false };
  }
  return { exceeded: Date.now() - streaks.budget.startedAt > streaks.budget.maxWallMs };
}

// ── Hard (tool, args) denylist ─────────────────────────────────────────────

/**
 * Record the outcome of one dispatched call. A failure increments the
 * signature's count; a success for the SAME signature resets it (the error is
 * fixed, so the call is not a retry loop). Returns the normalized signature
 * and whether it just crossed HARD_DENY_AFTER.
 */
export function recordCallFailure(
  streaks: LoopStreaks,
  name: string,
  args: Record<string, unknown>,
  ok: boolean
): { signature: string; count: number; denylisted: boolean } {
  const signature = normalizeCallSignature(name, args);
  if (ok) {
    streaks.callFailureCounts.delete(signature);
    return { signature, count: 0, denylisted: false };
  }
  const count = (streaks.callFailureCounts.get(signature) ?? 0) + 1;
  streaks.callFailureCounts.set(signature, count);
  return { signature, count, denylisted: count >= HARD_DENY_AFTER };
}

/**
 * The set of `tool|normalizedArgs` signatures that have failed
 * >= HARD_DENY_AFTER times. Callers MUST refuse these outright — do not
 * dispatch, do not re-approve; rung 3 of the intervention ladder surfaces
 * them to the model. Unlike the streak signals (which reset on compliance),
 * this set is sticky for the rest of the run.
 */
export function buildHardDenylist(streaks: LoopStreaks): Set<string> {
  const out = new Set<string>();
  for (const [signature, count] of streaks.callFailureCounts) {
    if (count >= HARD_DENY_AFTER) out.add(signature);
  }
  return out;
}

// ── 5-rung intervention ladder ─────────────────────────────────────────────

export type InterventionRung = 1 | 2 | 3 | 4 | 5;

export interface InterventionContext {
  /** Last tool result, quoted as evidence (rungs 1–2). */
  lastToolResults?: string;
  /** Reason line for the directive (defaults to the generic loop reason). */
  reason?: string;
  /** Ref of the last green checkpoint (rung 4). */
  checkpointRef?: string;
  /** Signatures currently on the hard denylist (rung 3; derived if omitted). */
  deniedSignatures?: string[];
}

/**
 * The escalation ladder, rungs 1–5. Callers climb one rung at a time:
 *   1. soft directive (the classic loop-break message)
 *   2. HALT — stop emitting tool calls entirely
 *   3. hard (tool,args) denylist — those exact calls are refused
 *   4. rollback to the last-green checkpoint
 *   5. ask the user — explicit, specific question
 * Rung 1's text is byte-identical to buildLoopBreakDirective for the same
 * reason/results, so existing injection sites can switch without a behaviour
 * change.
 */
export function buildInterventionDirective(
  streaks: LoopStreaks,
  rung: InterventionRung,
  context?: InterventionContext
): string {
  const reason = context?.reason ?? "You are repeating the same action";
  const evidence = (context?.lastToolResults ?? "").trim().replace(/\s+/g, " ").slice(0, 700);
  switch (rung) {
    case 1:
      return buildLoopBreakDirective({ loop: true, reason }, context?.lastToolResults);
    case 2: {
      const lines = [
        `[LOOP HALT] ${reason}. STOP emitting tool calls now — no call from this turn will run again.`,
        evidence ? `Your last tool result was: ${evidence}` : "",
        `Do not retry any previous call. State plainly: what you tried, the exact error you observed, and what you need next. Execution stays halted until your next message contains a genuinely different plan.`,
        `Ground every claim in tool results from THIS task: a file counts as changed only when a write/edit call returned success, and never invent output you did not receive.`,
      ];
      return lines.filter(Boolean).join("\n");
    }
    case 3: {
      const denied = (context?.deniedSignatures ?? Array.from(buildHardDenylist(streaks))).slice(0, 20);
      const lines = [
        `[LOOP BREAK — HARD DENYLIST] ${reason}. The following exact calls failed ${HARD_DENY_AFTER}x+ and are REFUSED for the rest of this task — re-sending them will not dispatch:`,
        ...denied.map((s) => `- ${s}`),
        `Recover a different way: fix the underlying error the failures share, change the arguments so the failure mode is actually different, or stop and state the blocker.`,
      ];
      return lines.filter(Boolean).join("\n");
    }
    case 4: {
      const ref = context?.checkpointRef ?? "the last green checkpoint";
      const lines = [
        `[LOOP BREAK — ROLLBACK] ${reason}. The workspace has not progressed; continuing on top of the current state will not succeed.`,
        `Roll back to ${ref} and re-approach the task from that known-good state. Do not continue editing on top of the current broken state.`,
        `After rolling back, take ONE different action — not a replay of the calls that got you here.`,
      ];
      return lines.filter(Boolean).join("\n");
    }
    case 5: {
      const lines = [
        `[LOOP BREAK — ASK THE USER] ${reason}. Autonomous retries have exhausted this line of approach. Stop and ask the user ONE specific question.`,
        `Your message must state: what you tried, why each attempt failed (with the actual error), and the single decision or piece of information you need to proceed. Do not emit further tool calls until the user answers.`,
      ];
      return lines.join("\n");
    }
  }
}
