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

// Read-only tools: exempt from the same-tool streak (never extend, never
// reset). Everything else — writes, commands, browser interactions,
// searches with side effects, scratchpad/todo spam — counts.
const READ_ONLY_TOOLS = new Set([
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
