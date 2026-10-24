// subagent.ts — spawn_subagent: every parallel research lane Claude Code has,
// but budgeted and sandboxed.
//
// What it is: a MINI turn loop (the same runTurnLoop engine as both lanes)
// with a deliberately tiny tool surface — READ-ONLY discovery only
// (list_files, read_file, search_code, code_search, scratchpad_read). The
// subagent answers a focused question ("find every call site of X",
// "summarize how auth works") and returns PROSE the parent folds into its
// transcript. It can never write, run commands, or touch the browser.
//
// Caps (Claude Code parity, Windows-8GB honest):
//   - depth 1: subagents cannot spawn subagents (spawnSubagent is simply not
//     present on their dispatch surface).
//   - global concurrency 2 per lane: MAX_CONCURRENT_SUBAGENTS. The third
//     request waits (bounded) or refuses honestly.
//   - turn cap: min(15, subagentLimit from the effort budget).
//
// Failure behavior: every error returns honest prose ("subagent failed:
// …"); never throws into the parent's tool loop.

import { runTurnLoop } from "./loop-engine";
import { createLoopStreaks } from "../loop-detect";

export type SubagentDispatch = (call: {
  name: string;
  path?: string;
  query?: string;
  context?: number;
  offset?: number;
  limit?: number;
  [k: string]: unknown;
}) => Promise<string>;

export interface SubagentOptions {
  /** The focused question. Sliced to a sane size. */
  task: string;
  /** Optional parent-supplied context (cwd, branch, what to look for). */
  context?: string;
  /** Turn cap (already effort-scaled by the caller). */
  maxTurns?: number;
  /** Aborted when the parent task aborts or is superseded. */
  signal?: AbortSignal | null;
}

export const SUBAGENT_ALLOWED_TOOLS = new Set([
  "list_files",
  "read_file",
  "search_code",
  "code_search",
]);
/** Bounded wait for a concurrency slot — beyond this, refuse honestly. */
export const SUBAGENT_SLOT_WAIT_MS = 120_000;
export const MAX_CONCURRENT_SUBAGENTS = 2;
export const SUBAGENT_BASE_TURN_CAP = 15;

const SUBAGENT_SYSTEM = `You are a read-only research subagent. Answer the assigned question using only discovery tools (list_files, read_file, search_code, code_search). You CANNOT write files, run commands, or browse. Be dense: quote exact paths and line hints, keep the answer under ~300 words, and end with a plain-text answer (no tool calls).`;

/** Complete tool-call spans, then a dangling (truncated) span tail → prose. */
function stripToolCallMarkup(text: string): string {
  let out = (text || "").replace(/[<]tool_call[\s\S]*?[<]\/tool_call[>]/g, " ");
  out = out.replace(/[<]tool_call[\s\S]*$/g, " ");
  return out.replace(/[ \t]+\n/g, "\n").trim();
}

/** Meaningful prose threshold — "findings"/"here is the answer" residue. */
const MIN_ANSWER_CHARS = 40;

/**
 * One in-flight subagent registry per lane process. `release` must always run
 * (finally), or a crashed subagent would eat a slot forever.
 */
class SubagentSlots {
  private active = 0;
  async acquire(signal?: AbortSignal | null, waitMs = SUBAGENT_SLOT_WAIT_MS): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    while (this.active >= MAX_CONCURRENT_SUBAGENTS) {
      if (Date.now() >= deadline) return false;
      if (signal?.aborted) return false;
      await new Promise((r) => setTimeout(r, 500));
    }
    this.active++;
    return true;
  }
  release() {
    this.active = Math.max(0, this.active - 1);
  }
  get inFlight(): number {
    return this.active;
  }
}

// Each lane imports its own module instance — one slot registry per lane.
const slots = new SubagentSlots();

export interface RunSubagentDeps {
  /** Mini-loop model call — provider adapter (server) or readStream (client). */
  callModel: (messages: Array<{ role: string; content: string }>) => Promise<{ content: string }>;
  /**
   * Dispatch one tool call against the PARENT's real tool machinery, pre-
   * gatekept to SUBAGENT_ALLOWED_TOOLS. Returning anything is tool_result XML.
   */
  dispatch: SubagentDispatch;
  /** Resolve on abort/supersede — mirror of the parent's throwAbort. */
  throwAbort?: () => Error;
  shouldAbort?: () => boolean;
}

/**
 * Run one read-only subagent to completion. Returns prose for the parent
 * transcript. All failure paths resolve with an honest error string.
 */
export async function runSubagent(
  deps: RunSubagentDeps,
  opts: SubagentOptions
): Promise<string> {
  const task = (opts.task || "").trim().slice(0, 4000);
  if (!task) return "error: spawn_subagent requires a task (the focused question to research).";

  if (opts.signal?.aborted) return "error: subagent aborted before start.";
  const gotSlot = await slots.acquire(opts.signal);
  if (!gotSlot) {
    // A false acquire is ambiguous: aborted mid-poll vs slot deadline. Report
    // the truth — an abort propagates per the engine's AbortError convention
    // (see the catch below), not as fictitious busy slots.
    if (opts.signal?.aborted) {
      const err = new Error("Subagent aborted");
      err.name = "AbortError";
      throw err;
    }
    return `error: too many subagents already running (${slots.inFlight > 0 ? MAX_CONCURRENT_SUBAGENTS : 0} slots busy) — do the research inline with read_file/search_code instead.`;
  }

  const transcript: Array<{ role: string; content: string }> = [];
  let refusedCount = 0;
  // Prose extracted from a mixed/markup turn — preferred over the raw turn
  // text so parent-visible findings never leak tool-call markup. Boxed so
  // callback writes defeat control-flow narrowing.
  const answerBox: { value: string | null } = { value: null };
  try {
    const contextLine = opts.context ? `\n\nParent context: ${opts.context.slice(0, 1000)}` : "";
    transcript.push({ role: "user", content: `${task}${contextLine}` });

    const exit = await runTurnLoop({
      maxTurns: Math.max(2, Math.min(opts.maxTurns ?? SUBAGENT_BASE_TURN_CAP, SUBAGENT_BASE_TURN_CAP)),
      parallelToolLimit: 2,
      shouldAbort: () => !!opts.signal?.aborted,
      throwAbort: () => new Error("Subagent aborted"),
      loopStreaks: createLoopStreaks(),
      // A subagent model may fall back to text-protocol tool calls mid-task —
      // same XML grammar both lanes parse (inline port, no async import).
      parseXmlToolCalls: (text) => {
        try {
          const calls: Array<Record<string, unknown> & { name: string }> = [];
          const re = new RegExp('<tool_call>\\s*([\\s\\S]*?)\\s*<\\/tool_call>', "g");
          let m: RegExpExecArray | null;
          while ((m = re.exec(text))) {
            try {
              const parsed = JSON.parse(m[1]);
              if (parsed && typeof parsed.name === "string") calls.push(parsed);
            } catch { /* unparseable call — the engine reports it as skipped */ }
          }
          return calls;
        } catch {
          return [];
        }
      },
      callModel: async () => {
        const out = await deps.callModel([
          { role: "system", content: SUBAGENT_SYSTEM },
          ...transcript,
        ]);
        return { content: out.content, toolCalls: [] };
      },
      onModelOutput: (_turn, out) => {
        // The assistant turn enters the mini transcript; onModelOutput is the
        // engine's designated lane hook exactly for this.
        transcript.push({ role: "assistant", content: out.content || "" });
      },
      filterToolCalls: (n) => SUBAGENT_ALLOWED_TOOLS.has(String(n)),
      onNoToolCalls: (_turn, out) => {
        // Non-empty prose = the final answer → break; the engine surfaces it
        // as exit.output. The discrimination, in priority order:
        //  - prose-FIRST turns (no markup head) are the model's final
        //    message — the stripped residual is the answer, whether or not
        //    a tool-call block trailed it (the block is removed, not leaked).
        //  - markup-FIRST turns need actual findings prose (>= 40 chars)
        //    to count as an answer — a stray fragment after a denied call
        //    must NOT end the run; they get the refusal nudge.
        //  - ONLY markup (empty residual) is never an answer: refusing it
        //    silently as "prose" would let the parent read refusal XML as
        //    findings.
        if (out?.content && out.content.trim()) {
          const residual = stripToolCallMarkup(out.content);
          const markupFirst = /^[ \t]*[<]tool_call/.test(out.content);
          if (residual && (!markupFirst || residual.length >= MIN_ANSWER_CHARS)) {
            answerBox.value = residual;
            return "break";
          }
          transcript.push({
            role: "user",
            content: !residual
              ? `refused: ${
                  out.content.includes("name")
                    ? "that tool is not available to subagents"
                    : "your attempt did not parse"
                } — subagents may only use list_files, read_file, search_code, code_search. Use one of those or produce your final prose answer.`
              : "That turn was mostly tool-call markup with no usable answer — subagents may only use list_files, read_file, search_code, code_search. Use one of those or produce your final prose answer.",
          });
          refusedCount++;
          return "continue";
        }
        transcript.push({
          role: "user",
          content:
            "No tool calls and no answer yet — pick a concrete discovery step (list_files or search_code) or produce your final answer now.",
        });
        return "continue";
      },
      onTruncatedOnly: () => {
        transcript.push({
          role: "user",
          content:
            "Your last tool_call was cut off by the output limit — re-emit the complete call.",
        });
      },
      dispatchCall: async (call, _callIndex) => {
        const name = String(call.name);
        if (!SUBAGENT_ALLOWED_TOOLS.has(name)) {
          return { resultXml: `<tool_result name="${name}">refused: subagents may only use ${[...SUBAGENT_ALLOWED_TOOLS].join(", ")}</tool_result>` };
        }
        let resultXml: string;
        try {
          resultXml = await deps.dispatch({
            name,
            path: (call as Record<string, unknown>).path as string | undefined,
            query: (call as Record<string, unknown>).query as string | undefined,
            context: (call as Record<string, unknown>).context as number | undefined,
            offset: (call as Record<string, unknown>).offset as number | undefined,
            limit: (call as Record<string, unknown>).limit as number | undefined,
          });
          if (!resultXml.includes("name=")) {
            resultXml = `<tool_result name="${name}">${resultXml}</tool_result>`;
          }
        } catch (err) {
          resultXml = `<tool_result name="${name}">error: ${String((err as Error).message).slice(0, 300)}</tool_result>`;
        }
        transcript.push({ role: "user", content: resultXml.slice(0, 8000) });
        return { resultXml };
      },
      onLoopTrip: () => {
        return "break";
      },
    });

    const finalText = exit.output?.content ?? "";
    if (exit.ended === "abort") throw new Error("Subagent aborted");
    // Mixed/markup turns: only the extracted prose reaches the parent.
    if (answerBox.value !== null) return answerBox.value.slice(0, 6000);
    const cleanedFinal = stripToolCallMarkup(finalText);
    if (cleanedFinal) return cleanedFinal.slice(0, 6000);
    if (exit.ended === "turn-limit" || exit.ended === "loop-stop") {
      if (refusedCount > 0) {
        return `refused: the subagent attempted tools outside its read-only sandbox ${refusedCount} time(s) and hit its turn cap without findings — do the research inline with read_file/search_code instead.`;
      }
      return `subagent stopped after ${exit.turn + 1} turn(s) without a final answer — findings inconclusive; do the specific research inline instead.`;
    }
    return "subagent finished without a definitive answer — findings inconclusive";
  } catch (err) {
    const msg = String((err as Error).message || err).slice(0, 300);
    if (/abort|Abort/i.test(msg)) throw err; // propagate parent aborts
    return `subagent failed: ${msg} — do the research inline instead.`;
  } finally {
    slots.release();
  }
}
