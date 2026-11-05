/**
 * thought-line.ts — assistant transcript → the ThoughtLine thread.
 *
 * The chat's live timeline IS the assistant message content: the worker
 * appends status lines ("running [npm test]"), result lines ("[OK] …"),
 * reasoning blocks ("[THINKING]…[/THINKING]") and gate/breaker markers to the
 * very string the UI renders. This module turns the PARSED segments of that
 * transcript into the steps the ThoughtLine component draws — one row per
 * thought, tool, gate, repair and stop — so the thread and the inline tool
 * chain can never disagree about what happened.
 *
 * Pure: no React, no DOM, no clock. The client component owns the hook and
 * reconciles the steps this module returns (see ThoughtThread.tsx).
 */

import type { ContentSegment } from "./message-content";
import {
  KIND_GLYPH,
  rowFromStatus,
  rowFromResult,
  rowFromToolCall,
  rowFromToolResult,
  type ToolRow,
} from "./tool-chain";

export type ThoughtKind = "think" | "tool" | "result";
export type ThoughtStatus = "active" | "done" | "error";

/** One row of the thread. `id` is stable for the life of the turn. */
export interface ThoughtStep {
  id: string;
  text: string;
  detail?: string;
  kind: ThoughtKind;
  status: ThoughtStatus;
  /**
   * Material Symbols ligature for the node — the SAME glyph the tool row
   * shows (KIND_GLYPH), so a tool looks identical in both UIs.
   */
  glyph?: string;
}

/** Longest detail kept per step — tool output can be megabytes. */
export const DETAIL_CAP = 2000;

/** Cap for the one-line outcome of the final answer. */
const OUTCOME_CAP = 140;

/** Truncate with an explicit marker so nobody reads a cut-off line as truth. */
export function truncateDetail(text: string, cap = DETAIL_CAP): string {
  const body = (text || "").trim();
  if (body.length <= cap) return body;
  return `${body.slice(0, cap)}\n… truncated (${body.length - cap} more characters)`;
}

// ============================================================================
// MARKERS — the gate / review / breaker lines the worker writes into the
// transcript. They are plain markdown, so they are matched by shape.
//
//   open   = starts a step that a later marker closes (a gate, a review)
//   close  = closes the open step
//   skip   = consumed, but not worth a row
// ============================================================================

interface Marker {
  kind: ThoughtKind;
  status: ThoughtStatus;
  text: string;
  detail?: string;
  opens?: boolean;
  closes?: boolean;
  skip?: boolean;
  /** The marker carries a block of indented continuation lines. */
  block?: boolean;
  /** The marker owns the REST of the text segment (a report block). */
  rest?: boolean;
  /** The block turns the row red when it matches (a FAIL verdict). */
  failIf?: RegExp;
  /** Material Symbols glyph for the node. */
  glyph?: string;
}

const MARKER_RULES: Array<[RegExp, (m: RegExpExecArray) => Marker | null]> = [
  // --- loop breaker / hard stops: always a failure -------------------------
  [
    /^\*\[Loop detected\s*[-â€”â€“]\s*(.+)\]\*$/,
    (m) => ({ kind: "think", status: "error", text: `Loop breaker: ${m[1]}`, detail: m[1], glyph: "loop" }),
  ],
  [
    /^\*\[Stopped\s*[-â€”â€“]\s*(.+)\]\*$/,
    (m) => ({ kind: "think", status: "error", text: `Stopped: ${m[1]}`, detail: m[1], glyph: "stop_circle" }),
  ],
  [
    /^\*\[Stopping\s*[-â€”â€“]\s*(.+)\]\*$/,
    (m) => ({ kind: "think", status: "error", text: `Stopped: ${m[1]}`, detail: m[1], glyph: "stop_circle" }),
  ],
  [
    /^\*\[Safety limit\s*[-â€”â€“]\s*(.+)\]\*$/,
    (m) => ({ kind: "think", status: "error", text: `Safety limit: ${m[1]}`, detail: m[1], glyph: "shield" }),
  ],
  [
    /^\*\[Turn limit\s*\((\d+)\)\s*reached\s*[-â€”â€“]\s*(.+)\]\*$/,
    (m) => ({ kind: "think", status: "error", text: `Turn limit (${m[1]}) reached: ${m[2]}`, detail: m[2], glyph: "timer_off" }),
  ],
  [
    /^\[INCOMPLETE\s*[-â€”â€“]\s*(.+)\]$/,
    (m) => ({ kind: "think", status: "error", text: "Incomplete: the reply was cut off", detail: m[1], glyph: "content_cut" }),
  ],
  [
    /^\*\*Task halted\*\*\s*[-â€”â€“]\s*(.+)$/,
    (m) => ({ kind: "think", status: "error", text: `Task halted: ${m[1]}`, detail: m[1], glyph: "pan_tool" }),
  ],

  // --- gates ---------------------------------------------------------------
  [
    /^\*\*Verifying changes[.…]*\*\*\s*(.*)$/,
    (m) => ({ kind: "tool", status: "done", text: "Gate: typecheck", detail: m[1] || undefined, opens: true, glyph: KIND_GLYPH.run }),
  ],
  [/^\*\*Verification passed\*\*/, () => ({ kind: "tool", status: "done", text: "", closes: true })],
  [/^\*\*Verification failed\*\*/, () => ({ kind: "tool", status: "error", text: "", closes: true })],
  [/^\*\*Verification still failing\*\*/, () => ({ kind: "tool", status: "error", text: "", closes: true })],
  // The lane could not run at all. "skipped" is not "pass" — it closes the
  // open gate as a failure, exactly like the worker's own verdict logic.
  [
    /^\*\*Typecheck not verified\*\*/,
    (m) => ({ kind: "tool", status: "error", text: "", closes: true, detail: m[0].replace(/^\*\*Typecheck not verified\*\*/, "").trim() }),
  ],
  [
    /^\*\*Gate pipeline\*\*\s*[-â€”â€“]\s*verdict\s+(PASS|FAIL)/i,
    (m) => ({
      kind: "tool",
      status: /fail/i.test(m[1]) ? "error" : "done",
      text: "Gate pipeline",
      detail: m[0].replace(/^\*\*Gate pipeline\*\*\s*[-â€”â€“]\s*/i, ""),
      block: true,
      glyph: "verified",
    }),
  ],
  [
    /^\*\*Browser verification[.…]*\*\*/,
    () => ({ kind: "tool", status: "done", text: "Gate: browser", opens: true, glyph: KIND_GLYPH.browser }),
  ],
  [/^\*\*Browser verification passed/, () => ({ kind: "tool", status: "done", text: "", closes: true })],
  [/^\*\*Browser verification still failing/, () => ({ kind: "tool", status: "error", text: "", closes: true })],
  [
    /^\*\*UI broken\s*[-â€”â€“]\s*repairing[.…]*\*\*/,
    () => ({ kind: "tool", status: "done", text: "Repair: UI verification", glyph: "build" }),
  ],
  [
    /^\*\*Swarm found issues\s*[-â€”â€“]\s*repairing[.…]*\*\*/,
    () => ({ kind: "tool", status: "done", text: "Repair: review findings", glyph: "build" }),
  ],
  [
    /^\*\*Edit lock engaged\*\*/,
    (m) => ({ kind: "tool", status: "done", text: "Edit lock engaged", detail: m[0].replace(/^\*\*Edit lock engaged\*\*/, "").trim() || undefined, glyph: "lock" }),
  ],

  // --- reviewer / verifier roles -------------------------------------------
  [
    /^\*\*Self-review:\*\*/,
    (m) => ({
      kind: "think",
      status: "done",
      text: "Reviewer: self-review",
      detail: m[0].replace(/^\*\*Self-review:\*\*/, "").trim() || undefined,
      opens: true,
      glyph: "rate_review",
    }),
  ],
  [
    /^\*\*Self-review after fixes:\*\*/,
    (m) => ({
      kind: "think",
      status: "done",
      text: "Reviewer: self-review",
      detail: m[0].replace(/^\*\*Self-review after fixes:\*\*/, "").trim() || undefined,
      opens: true,
      glyph: "rate_review",
    }),
  ],
  [/^\*\*Self-review passed\*\*/, () => ({ kind: "think", status: "done", text: "", closes: true })],
  [
    /^\*\*Code review:\*\*/,
    (m) => ({
      kind: "think",
      status: "done",
      text: "Reviewer: code review",
      detail: m[0].replace(/^\*\*Code review:\*\*/, "").trim() || undefined,
      opens: true,
      glyph: "rate_review",
    }),
  ],
  [/^\*\*Code review passed\*\*/, () => ({ kind: "think", status: "done", text: "", closes: true })],

  // --- policy blocks -------------------------------------------------------
  [
    /^\[GATE\]\s*(.+)$/,
    (m) => ({ kind: "tool", status: "error", text: `Gate blocked: ${m[1]}`, detail: m[1], glyph: "lock" }),
  ],
  [
    /^\[LOOP\]\s*(.+)$/,
    (m) => {
      // A rung is a queued directive, not a refusal — the call still runs
      // differently next turn. Only a refusal is a red breaker.
      const soft = /intervention rung/i.test(m[1]);
      return {
        kind: "think" as const,
        status: soft ? ("done" as const) : ("error" as const),
        text: soft ? `Loop intervention: ${m[1]}` : `Loop breaker: ${m[1]}`,
        detail: m[1],
        glyph: soft ? "loop" : "loop",
      };
    },
  ],
  [
    /^\[CAPABILITY\]\s*(.+)$/,
    (m) => {
      // "user approved" is a SUCCESS — painting it red would lie.
      const approved = /user approved/i.test(m[1]);
      return {
        kind: "tool" as const,
        status: approved ? ("done" as const) : ("error" as const),
        text: approved ? `Capability approved: ${m[1]}` : `Capability blocked: ${m[1]}`,
        detail: m[1],
        glyph: approved ? "task_alt" : "block",
      };
    },
  ],
  [
    /^\[PATH-JAIL\]\s*(.+)$/,
    (m) => ({ kind: "tool", status: "error", text: `Path blocked: ${m[1]}`, detail: m[1], glyph: "block" }),
  ],
  [
    /^\[FLAKE\]\s*(.+)$/,
    (m) => ({ kind: "tool", status: "done", text: "Flaky lane ignored", detail: m[1], glyph: "autorenew" }),
  ],
  [
    /^\*\*\[TAMPER\]\*\*/,
    (m) => ({ kind: "tool", status: "error", text: "Tamper signal detected", detail: m[0], block: true, glyph: "gpp_bad" }),
  ],
  [
    /^\*\*spawn_subagent\*\*\s*(.*)$/,
    (m) => ({ kind: "tool", status: "done", text: "Sub-agent", detail: m[1] || undefined, glyph: "groups" }),
  ],
  [
    /^VERIFICATION REPORT\s*[-â€”â€“]\s*(.*)$/,
    (m) => ({
      kind: "tool",
      status: "done",
      text: "Verification report",
      detail: m[0],
      rest: true,
      failIf: /^Result:\s*FAIL/im,
      glyph: "verified",
    }),
  ],

  // --- notices: consumed, no row -------------------------------------------
  [/^\*\[Failure context from previous task injected/, () => ({ kind: "think", status: "done", text: "", skip: true })],
  [/^\*\[Workspace learnings applied\]\*$/, () => ({ kind: "think", status: "done", text: "", skip: true })],
  [/^\*\[Playbook learnings applied\]\*$/, () => ({ kind: "think", status: "done", text: "", skip: true })],
  [/^\*\[Continuing\s*[-â€”â€“]\s*limit reset by user/, () => ({ kind: "think", status: "done", text: "", skip: true })],
  [/^\*\*\[Workspace already in context/, () => ({ kind: "think", status: "done", text: "", skip: true })],
  [/^\*Code review unavailable/, () => ({ kind: "think", status: "done", text: "", skip: true })],
  [/^\*Browser verification skipped/, () => ({ kind: "think", status: "done", text: "", skip: true })],
  [/^\*Browser verification unavailable/, () => ({ kind: "think", status: "done", text: "", skip: true })],
];

/** Match one transcript line against the marker table. */
function matchMarker(line: string): Marker | null {
  for (const [re, build] of MARKER_RULES) {
    const m = re.exec(line);
    if (m) return build(m);
  }
  return null;
}

// ============================================================================
// DRAFTS — the steps while they are being built. `open` marks a step that is
// still running (a tool without its result, a gate without its verdict).
// ============================================================================

interface Draft {
  text: string;
  detail?: string;
  kind: ThoughtKind;
  status: ThoughtStatus;
  open: boolean;
  glyph?: string;
}

// ============================================================================
// TOOL ROWS — the inline chain's own builders, so both views agree.
// ============================================================================

/** Detail of a tool step: its arguments, then the output once it lands. */
function toolDetail(row: ToolRow): string {
  const parts: string[] = [];
  if (row.args) parts.push(row.args);
  if (row.detail) parts.push(row.detail);
  return parts.join("\n");
}

/**
 * The row's headline, in the tool-call wording: the tool name and its
 * argument ("Read to-check.txt"). The same words the inline chain shows, so
 * the two UIs read as one.
 */
function toolHeadline(row: ToolRow): string {
  const args = (row.args || "").trim();
  return args ? `${row.name} ${args}` : row.name;
}

/** One-line summary of a reasoning block. */
function thinkingSummary(text: string): string {
  const line = (text || "").trim().split("\n").find((l) => l.trim().length > 0) || "";
  const clean = line.replace(/^[-*#>\s]+/, "").trim();
  return clean.length > 90 ? `${clean.slice(0, 90)}…` : clean || "Thinking";
}

// ============================================================================
// RESULT — the one-line outcome of the final answer.
// ============================================================================

/** Strip the markdown chrome from a heading / bold lead-in. */
function cleanOutcome(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\*\*(.+)\*\*:?$/, "$1")
    .replace(/^[-*+]\s+/, "")
    .trim();
}

/**
 * The trailing prose of the turn, reduced to one line. The transcript's last
 * text segment is the model's final answer (plus the trailing "---" rule and
 * the token-meter line, both of which are dropped).
 */
export function outcomeFromText(text: string): string {
  const lines = (text || "").split("\n");
  // Drop the tail decorations: a horizontal rule and the italic meter line.
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (!last) {
      lines.pop();
      continue;
    }
    if (/^[-*_]{3,}$/.test(last)) {
      lines.pop();
      continue;
    }
    if (/^\*[^*\n]+\*$/.test(last)) {
      lines.pop();
      continue;
    }
    break;
  }
  for (const raw of lines) {
    const line = cleanOutcome(raw);
    if (!line) continue;
    if (matchMarker(line)) continue;
    return line.length > OUTCOME_CAP ? `${line.slice(0, OUTCOME_CAP)}…` : line;
  }
  return "";
}

// ============================================================================
// DERIVE — segments → steps.
// ============================================================================

export interface DeriveOptions {
  /**
   * The turn is still running. The last OPEN step stays active so the reader
   * can see what the agent is doing right now; a finished turn never leaves an
   * active step behind (a reload must not look like it is still working).
   */
  live?: boolean;
}

export function deriveThoughtSteps(
  segments: ContentSegment[],
  options: DeriveOptions = {}
): ThoughtStep[] {
  const live = options.live === true;
  const drafts: Draft[] = [];
  /** Index of the tool row still waiting for its result. */
  let openTool = -1;
  /** Index of the gate/reviewer step still waiting for its verdict. */
  let openMarker = -1;
  /** The trailing prose of the turn — the final answer. */
  let trailingProse = "";

  const push = (draft: Draft): number => {
    drafts.push(draft);
    return drafts.length - 1;
  };

  /** Fold a finished tool row into the row that was running. */
  const finishTool = (row: ToolRow, output: string, failed: boolean) => {
    if (openTool >= 0 && drafts[openTool] && drafts[openTool].open) {
      const draft = drafts[openTool];
      const base = (draft.detail || "").trim();
      const body = (output || "").trim();
      // The body GROWS (args → args + output), so the thread streams the
      // delta into the row instead of rewriting it.
      draft.detail = truncateDetail(base ? `${base}\n\n${body}` : body);
      draft.status = failed ? "error" : "done";
      draft.open = false;
      openTool = -1;
      return;
    }
    // No start line survived (the worker replaced it with the result line).
    push({
      text: toolHeadline(row),
      detail: truncateDetail(toolDetail(row)),
      kind: "tool",
      status: failed ? "error" : "done",
      open: false,
      glyph: KIND_GLYPH[row.kind],
    });
  };

  for (const segment of segments) {
    switch (segment.type) {
      case "thinking": {
        push({
          text: thinkingSummary(segment.content),
          detail: truncateDetail(segment.content),
          kind: "think",
          status: "done",
          open: false,
        });
        break;
      }

      case "status": {
        const row = rowFromStatus(segment);
        openTool = push({
          text: toolHeadline(row),
          detail: truncateDetail(toolDetail(row)),
          kind: "tool",
          status: "done",
          open: true,
          glyph: KIND_GLYPH[row.kind],
        });
        break;
      }

      case "success":
      case "error": {
        const row = rowFromResult(segment);
        finishTool(row, row.detail || row.args || "", segment.type === "error");
        break;
      }

      case "tool_call": {
        const row = rowFromToolCall(segment);
        openTool = push({
          text: toolHeadline(row),
          detail: truncateDetail(toolDetail(row)),
          kind: "tool",
          status: "done",
          open: true,
          glyph: KIND_GLYPH[row.kind],
        });
        break;
      }

      case "tool_result": {
        const row = rowFromToolResult(segment);
        const failed = row.state === "error";
        finishTool(row, row.detail || "", failed);
        break;
      }

      case "interrupted": {
        push({
          text: "Interrupted — the page was reloaded mid-task",
          kind: "think",
          status: "error",
          open: false,
          glyph: "power_settings_new",
        });
        break;
      }

      case "failed": {
        push({ text: "The response failed", kind: "think", status: "error", open: false, glyph: "error" });
        break;
      }

      case "text": {
        const text = segment.content;
        const lines = text.split("\n");
        let prose: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i];
          const line = raw.trim();
          if (!line) {
            prose.push(raw);
            continue;
          }
          const marker = matchMarker(line);
          if (!marker) {
            prose.push(raw);
            continue;
          }
          if (marker.skip) continue;

          if (marker.closes) {
            if (openMarker >= 0 && drafts[openMarker]) {
              const draft = drafts[openMarker];
              draft.status = marker.status;
              draft.open = false;
              draft.detail = truncateDetail(
                [draft.detail, line.replace(/^\*+/, "").replace(/\*+$/, "")].filter(Boolean).join("\n"),
              );
            }
            openMarker = -1;
            continue;
          }

          let detail = marker.detail;
          if (marker.block) {
            // Collect the indented continuation lines (lane results, findings).
            const extra: string[] = [];
            while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) {
              extra.push(lines[++i].trim());
            }
            if (extra.length) detail = [detail, ...extra].filter(Boolean).join("\n");
          }
          if (marker.rest) {
            // The marker owns everything that follows it in this segment.
            const rest = lines.slice(i + 1).join("\n").trim();
            i = lines.length - 1;
            if (rest) detail = [detail, rest].filter(Boolean).join("\n");
            if (marker.failIf && marker.failIf.test(rest)) marker.status = "error";
          }

          const index = push({
            text: marker.text,
            detail: detail ? truncateDetail(detail) : undefined,
            kind: marker.kind,
            status: marker.status,
            open: marker.opens === true,
            glyph: marker.glyph,
          });
          if (marker.opens) openMarker = index;
          continue;
        }
        const joined = prose.join("\n").trim();
        if (joined) trailingProse = joined;
        break;
      }

      default:
        break;
    }
  }

  // The final answer: one row, one line. Only when the turn actually has
  // structure — a prose-only message would just repeat itself.
  const hasStructure = drafts.some((d) => d.kind !== "think" || d.status === "error");
  if (!live && hasStructure) {
    const outcome = outcomeFromText(trailingProse);
    if (outcome) {
      push({ text: outcome, kind: "result", status: "done", open: false });
    }
  }

  // Live: the last open step is what the agent is doing right now.
  // Finished: nothing stays active (a reload must not look unfinished).
  if (live) {
    const last = drafts[drafts.length - 1];
    if (last && last.open) last.status = "active";
  }

  return drafts.map((draft, i) => ({
    id: `tl-${i}`,
    text: draft.text,
    detail: draft.detail,
    kind: draft.kind,
    status: draft.status,
    glyph: draft.glyph,
  }));
}
