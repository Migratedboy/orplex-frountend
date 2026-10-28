// loop-engine.ts — The shared turn-loop harness for both agent lanes.
//
// background-worker.ts (browser lane) and server-executor/executor.ts (server
// lane) are hand-copied loops sharing only src/lib/agent/contract/. Every
// loop mechanic (turn cap, empty-response stop, native-vs-text parsing,
// truncation handling, the loop breaker, dispatch, result assembly) existed
// twice and drifted: the server lane lacked the truncation-continue path,
// the client lane lacks the whitelist filter, and the two parses disagreed.
//
// This module extracts the loop SKELETON into one engine. Each lane supplies
// hooks for the genuinely lane-specific behavior (model transport, gating,
// approval, display) and the engine owns the control flow — same ordering,
// same termination rules, same parsing dialect everywhere. It also owns
// PARALLEL READ DISPATCH: consecutive read-only calls in one turn run
// concurrently (bounded by the lane's effort-scaled limit) while
// state-changing calls stay strictly sequential in original call order, so
// the transcript the model sees keeps its historical shape.
//
// The engine imports NOTHING client-only and NOTHING server-only — it is a
// pure control harness. XML parsing functions and the ToolCall shape are
// injected by the lane (client: stream-reader dialect; server: tool-text
// dialect).

import {
  trackToolTurn,
  createLoopStreaks,
  type LoopStreaks,
  type LoopVerdict,
} from "../loop-detect";

/** One model call's parseable output in the engine's dialect. */
export interface TurnOutput {
  /** The assistant's content (may include the XML tool-call text). */
  content: string;
  /** Native function-calling calls when the transport produced them (may be empty). */
  toolCalls: Array<Record<string, unknown> & { name: string }>;
}

export interface ParsedTurnCalls {
  /** Dispatchable calls in order: native if present, else XML + bare-JSON recovery. */
  calls: Array<Record<string, unknown> & { name: string }>;
  /** Calls dropped for missing required args (transcription-truncation victims). */
  truncated: Array<Record<string, unknown> & { name: string }>;
  /** Calls removed by the lane's tool whitelist — they must be reported to
   *  the model, otherwise it assumes they ran. */
  filteredOut: Array<Record<string, unknown> & { name: string }>;
}

export interface DispatchedCall {
  resultXml: string;
  dedupRead?: boolean;
}

export interface TurnDispatchInfo {
  /** Per-call <tool_result> XML, in the ORIGINAL call order. */
  results: string[];
  calls: Array<Record<string, unknown> & { name: string }>;
  /** true when at least one read was served from the dedup cache. */
  anyDup: boolean;
}

export interface TurnLoopExit {
  /** Index of the last executed turn (0-based). */
  turn: number;
  ended: "no-calls" | "loop-stop" | "safety-stop" | "lane-stop" | "turn-limit" | "abort";
  /** The model output that produced the exit (final answer on "no-calls"). */
  output: TurnOutput | null;
}

export type LoopAction = "break" | "continue" | null;

export interface TurnLoopOptions {
  maxTurns: number;

  /** Called at loop head each turn — status refresh, compaction, budget checks. */
  onTurnStart?: (turn: number) => void | Promise<void>;
  /** The lane's model transport (SSE stream or provider adapter). */
  callModel: (turn: number) => Promise<TurnOutput>;
  /** Right after a successful model call (before parsing) — the lane
   *  appends the assistant transcript entry / seals display buffers here. */
  onModelOutput?: (turn: number, out: TurnOutput) => void | Promise<void>;
  /** Transport errors. Return "retry-turn" to redo the SAME turn (retry budget is the lane's). */
  onModelError?: (turn: number, err: unknown) => "retry-turn" | "throw" | Promise<"retry-turn" | "throw">;

  /** Stop pressed / task superseded — checked at loop head and before dispatch. */
  shouldAbort?: () => boolean;
  /** The abort error to throw when shouldAbort flips. */
  throwAbort: () => Error;

  /**
   * Tool-call XML parser for the lane (client: stream-reader's, server:
   * tool-text's). Called only when the turn produced no native calls.
   */
  parseXmlToolCalls: (text: string) => Array<Record<string, unknown> & { name: string }>;
  /**
   * Bare-JSON recovery for the lane — tried only when the XML parser found
   * nothing (the shared convention; never applied twice).
   */
  parseBareJsonToolCalls?: (text: string) => Array<Record<string, unknown> & { name: string }>;
  /**
   * Optional post-parse whitelist (the server's TOOL_WHITELIST + mcp__*).
   * Applied AFTER recovery, matching the server lane's historical order.
   */
  filterToolCalls?: (name: string) => boolean;

  /** Lane decides the no-call flow: nudge directives, final answer, dup prompts. */
  onNoToolCalls?: (
    turn: number,
    out: TurnOutput,
    textOnly: string
  ) => LoopAction | Promise<LoopAction>;
  /** Called when the turn HAS dispatchable calls, before the loop tracker —
   *  the lane records toolCounts / counters here (worker parity: counts must
   *  precede the detector and the safety gates). */
  onTurnCalls?: (
    turn: number,
    out: TurnOutput,
    calls: ParsedTurnCalls["calls"]
  ) => void | Promise<void>;
  /** All calls truncated (none dispatchable) — lane pushes the continue directive. */
  onTruncatedOnly?: (
    turn: number,
    truncated: ParsedTurnCalls["truncated"],
    out: TurnOutput
  ) => void | Promise<void>;
  /** Some calls lost required arguments (dropped before dispatch). The lane
   *  should tell the model which calls never ran — otherwise it assumes they
   *  executed and moves on with missing work. */
  onTruncated?: (
    turn: number,
    truncated: ParsedTurnCalls["truncated"],
    out: TurnOutput
  ) => void | Promise<void>;
  /** Calls removed by the lane's tool whitelist — report them so the model
   *  knows the tool is unavailable here instead of silently losing the work. */
  onFilteredCalls?: (
    turn: number,
    filtered: ParsedTurnCalls["filteredOut"],
    out: TurnOutput
  ) => void | Promise<void>;

  /** Lane's streak state; the engine calls trackToolTurn with it. */
  loopStreaks: LoopStreaks;
  /** Loop detected — lane displays the break directive and returns the action. */
  onLoopTrip: (
    verdict: LoopVerdict,
    out: TurnOutput,
    textOnly: string
  ) => LoopAction | Promise<LoopAction>;

  /** Last gate before dispatch (safety caps, wall-clock). */
  preDispatch?: (
    turn: number,
    out: TurnOutput,
    calls: ParsedTurnCalls["calls"]
  ) => LoopAction | Promise<LoopAction>;

  /** Dispatch ONE call — the lane's gating chain + dispatcher. Second arg is
   *  the call's zero-based index within THIS turn's call list. */
  dispatchCall: (call: Record<string, unknown> & { name: string }, callIndex: number) => Promise<DispatchedCall>;
  /** Max concurrent read-only calls per turn; 1 (default) = fully sequential. */
  parallelToolLimit?: number;

  /** After dispatch: dup-read second chance, transcript append. May end the loop. */
  postDispatch?: (
    turn: number,
    out: TurnOutput,
    info: TurnDispatchInfo
  ) => LoopAction | Promise<LoopAction>;
}

/**
 * Tools safe to dispatch concurrently. Derives from loop-detect's canonical
 * READ_ONLY_TOOLS but stricter: browser state ops (tabs, waits, screenshots)
 * mutate or observe a live session, so they stay sequential; scratchpad and
 * todo writes stay sequential (order matters); everything NOT in this set —
 * including every mcp__* / mcp_call (unknown third-party tools) — fails
 * closed to sequential dispatch.
 */
const PARALLEL_SAFE_TOOLS = new Set([
  "read_file",
  "list_files",
  "search_code",
  "code_search",
  "web_search",
  "use_skill",
  "browser_read",
  "browser_find",
  "browser_console",
  "browser_network",
  "mcp_search_tools",
  "mcp_describe_tool",
  "session_search",
  "playbook_search",
]);

export function isParallelSafeTool(name: string): boolean {
  return PARALLEL_SAFE_TOOLS.has(name);
}

/**
 * Partition calls into groups: consecutive parallel-safe calls form parallel
 * batches (capped at `limit`; the overflow runs as the NEXT batch — order
 * beats latency), a state-changing call always runs alone. Appending the
 * per-call results in group order equals the original call order.
 */
export function planTurnDispatch(
  calls: Array<Record<string, unknown> & { name: string }>,
  limit: number
): Array<{ parallel: boolean; calls: Array<Record<string, unknown> & { name: string }> }> {
  const effectiveLimit = Math.max(1, Math.floor(limit));
  const groups: Array<{ parallel: boolean; calls: Array<Record<string, unknown> & { name: string }> }> = [];
  let buffer: Array<Record<string, unknown> & { name: string }> = [];
  const flushBuffer = () => {
    if (buffer.length === 0) return;
    if (buffer.length <= effectiveLimit) {
      // Single batch — parallel only when there is more than one call.
      groups.push({ parallel: buffer.length > 1, calls: buffer });
    } else {
      // Over the limit: bounded batches, each awaiting the previous one —
      // call order is preserved exactly.
      for (let i = 0; i < buffer.length; i += effectiveLimit) {
        groups.push({ parallel: buffer.length - i > 1, calls: buffer.slice(i, i + effectiveLimit) });
      }
    }
    buffer = [];
  };
  for (const call of calls) {
    if (isParallelSafeTool(String(call.name))) buffer.push(call);
    else {
      flushBuffer();
      groups.push({ parallel: false, calls: [call] });
    }
  }
  flushBuffer();
  return groups;
}

/** Dispatch a turn's calls in the engine's group order; results in call order. */
export async function dispatchTurnCalls(
  calls: Array<Record<string, unknown> & { name: string }>,
  dispatchCall: (call: Record<string, unknown> & { name: string }, index: number) => Promise<DispatchedCall>,
  limit: number
): Promise<{ results: string[]; outcomes: (DispatchedCall | null)[]; anyDup: boolean }> {
  const groups = planTurnDispatch(calls, limit);
  const outcomes: (DispatchedCall | null)[] = new Array(calls.length).fill(null);
  // map call object → its index (duplicate call objects are still distinct entries)
  const indexOf = new Map<Record<string, unknown>, number>();
  calls.forEach((c, i) => indexOf.set(c, i));
  let anyDup = false;
  for (const group of groups) {
    if (!group.parallel) {
      const idx = indexOf.get(group.calls[0])!;
      outcomes[idx] = await dispatchCall(group.calls[0], idx);
      if (outcomes[idx]?.dedupRead) anyDup = true;
      continue;
    }
    const settled = await Promise.all(
      group.calls.map(async (call) => {
        const idx = indexOf.get(call)!;
        try {
          return { idx, outcome: await dispatchCall(call, idx) };
        } catch (err) {
          // Aborts are control flow, not tool failures — they unwind the turn.
          if ((err as { name?: string })?.name === "AbortError") throw err;
          return { idx, outcome: null };
        }
      })
    );
    for (const { idx, outcome } of settled) {
      outcomes[idx] = outcome;
      if (outcome?.dedupRead) anyDup = true;
    }
  }
  const results = outcomes.map((o, i) =>
    o ? o.resultXml : `<tool_result name="${String(calls[i].name)}">\nerror: dispatch failed\n</tool_result>\n`
  );
  return { results, outcomes, anyDup };
}

/**
 * Shared tool-call parsing: native calls win; otherwise XML `<tool_call>`
 * JSON blocks with bare-JSON recovery when the XML parser found nothing
 * (the shared convention; never applied twice). Truncation detection is the
 * union both lanes converged on: a write/edit/read whose required args are
 * missing can never dispatch.
 */
export function parseTurnCalls(
  out: TurnOutput,
  opts: {
    parseXmlToolCalls: TurnLoopOptions["parseXmlToolCalls"];
    parseBareJsonToolCalls?: TurnLoopOptions["parseBareJsonToolCalls"];
    filterToolCalls?: TurnLoopOptions["filterToolCalls"];
  }
): ParsedTurnCalls {
  let raw: Array<Record<string, unknown> & { name: string }> = [];

  if (out.toolCalls.length > 0) {
    // Target wins: a model argument literally named "name" must never
    // overwrite the dispatch target (split-deploy lanes strip it the same
    // way; a legit `name` parameter stays undeliverable via flat calls —
    // known flat-call limitation, documented at the dispatch sites).
    raw = out.toolCalls.map((c) => ({ ...c, name: c.name }));
  } else {
    const text = out.content || "";
    raw = opts.parseXmlToolCalls(text);
    if (raw.length === 0 && opts.parseBareJsonToolCalls) {
      raw = opts.parseBareJsonToolCalls(text);
    }
  }
  const filteredOut: Array<Record<string, unknown> & { name: string }> = [];
  if (opts.filterToolCalls) {
    const allowed = opts.filterToolCalls;
    for (const c of raw) {
      if (allowed(String(c.name))) continue;
      filteredOut.push(c);
    }
    raw = raw.filter((c) => allowed(String(c.name)));
  }

  // Truncation detection — the intersection both loops shipped:
  const truncated = raw.filter((tc) => {
    if (tc.name === "write_file" && (!tc.path || tc.content === undefined)) return true;
    if (tc.name === "edit_file" && (!tc.path || !tc.old_text || !tc.new_text)) return true;
    if (tc.name === "read_file" && !tc.path) return true;
    return false;
  });
  const calls = raw.filter((tc) => !truncated.includes(tc));
  return { calls, truncated, filteredOut };
}

const STRIP_XML_RE = /[<]tool_call[\s\S]*?[<]\/tool_call[>]/g;

/** Text-only residue for a turn (calls stripped) — lanes display/branch on it. */
export function stripToolCallText(content: string): string {
  return (content || "").replace(STRIP_XML_RE, "").trim();
}

/**
 * The loop skeleton shared by both lanes. Hook order (per turn):
 *   abort-check → onTurnStart → callModel → abort-check → parse
 *   → no-calls path (onNoToolCalls → break/continue)
 *   → truncated-only path (onTruncatedOnly → continue)
 *   → loop tracker (onLoopTrip → break/continue)
 *   → preDispatch gate → dispatch (parallel reads) → postDispatch
 * A hook returning "break"/"continue" short-circuits identically to what the
 * hand-copied loops did (their `break`/`continue` statements).
 */
export async function runTurnLoop(opts: TurnLoopOptions): Promise<TurnLoopExit> {
  const limit = Math.max(1, Math.floor(opts.parallelToolLimit ?? 1));
  let lastTurn = 0;
  for (let turn = 0; turn < opts.maxTurns; turn++) {
    lastTurn = turn;
    if (opts.shouldAbort?.()) throw opts.throwAbort();

    await opts.onTurnStart?.(turn);
    if (opts.shouldAbort?.()) throw opts.throwAbort();

    let out: TurnOutput;
    try {
      out = await opts.callModel(turn);
    } catch (err) {
      const verdict = opts.onModelError ? await opts.onModelError(turn, err) : "throw";
      if (verdict === "retry-turn") {
        turn--; // redo the same turn (loop increment re-applies)
        continue;
      }
      throw err;
    }

    if (opts.shouldAbort?.()) throw opts.throwAbort();

    await opts.onModelOutput?.(turn, out);

    const parsed = parseTurnCalls(out, {
      parseXmlToolCalls: opts.parseXmlToolCalls,
      parseBareJsonToolCalls: opts.parseBareJsonToolCalls,
      filterToolCalls: opts.filterToolCalls,
    });

    const textOnly = stripToolCallText(out.content);

    // === FILTERED CALLS: tool not available in this lane ====================
    if (parsed.filteredOut.length > 0) {
      await opts.onFilteredCalls?.(turn, parsed.filteredOut, out);
    }

    // === TRUNCATED-ONLY: every call in this turn lost required args =========
    if (parsed.truncated.length > 0 && parsed.calls.length > 0) {
      // Mixed turn: some calls ran, others were dropped before dispatch.
      // Tell the lane which ones never ran — a silently dropped call looks to
      // the model like a successful one.
      await opts.onTruncated?.(turn, parsed.truncated, out);
    }
    if (parsed.truncated.length > 0 && parsed.calls.length === 0) {
      await opts.onTruncatedOnly?.(turn, parsed.truncated, out);
      continue;
    }

    // === NO VALID CALLS: final answer, or a lane nudge/retry ================
    if (parsed.calls.length === 0) {
      const action = opts.onNoToolCalls ? await opts.onNoToolCalls(turn, out, textOnly) : null;
      if (action === "continue") continue;
      return { turn, ended: "no-calls", output: out };
    }

    // === LANE COUNTERS: before the tracker (worker parity) ===================
    if (opts.onTurnCalls) await opts.onTurnCalls(turn, out, parsed.calls);

    // === LOOP BREAKER: verdict BEFORE dispatch (a trip never runs the call) =
    const verdict = trackToolTurn(opts.loopStreaks, parsed.calls);
    if (verdict.loop) {
      const action = await opts.onLoopTrip(verdict, out, textOnly);
      if (action === "continue") continue;
      return { turn, ended: "loop-stop", output: out };
    }

    // === PRE-DISPATCH GATE: safety caps, wall clock ==========================
    if (opts.preDispatch) {
      const action = await opts.preDispatch(turn, out, parsed.calls);
      if (action === "continue") continue;
      if (action === "break") return { turn, ended: "safety-stop", output: out };
    }
    if (opts.shouldAbort?.()) throw opts.throwAbort();

    // === DISPATCH ============================================================
    const { results, anyDup } = await dispatchTurnCalls(parsed.calls, opts.dispatchCall, limit);

    // === POST-DISPATCH: dup-read second chance + transcript append ===========
    if (opts.postDispatch) {
      const action = await opts.postDispatch(turn, out, {
        results,
        calls: parsed.calls,
        anyDup,
      });
      if (action === "continue") continue;
      if (action === "break") return { turn, ended: "lane-stop", output: out };
    }
  }
  return { turn: lastTurn, ended: "turn-limit", output: null };
}

export { createLoopStreaks, buildLoopBreakDirective } from "../loop-detect";
