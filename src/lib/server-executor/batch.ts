// batch.ts — batch_execute: speculative multi-worker execution (server lane).
//
// What it is: the same root repo gets 2-3 real git worktrees (worktree.ts),
// each running ONE focused variant of the task on the parent's model adapter,
// in PARALLEL. When they finish, a consensus gate decides the outcome:
//   - ≥2 workers agree (identical patch text, or the same changed-file set
//     with materially equal patches) → their branch is merged back into the
//     repo root by mergeBack, the losers are cleaned up.
//   - No agreement → NOTHING is merged. The parent gets an honest report of
//     every variant's diff so it (the orchestrator loop) can adapt.
//
// This is the execution analogue of Claude Code's parallel subagents, but for
// WRITES — which is why it is server-lane-only (real worktrees) and why the
// fallback is "no merge" rather than guessing.
//
// Workers are NOTTURN-loop-only by design: they may not nest batch_execute or
// spawn_subagent, and they cap at 8 turns — variant execution is supposed to
// be short and decisive, not a second main loop.

import { createIsolatedContext, type WorktreeContext } from "./worktree";
import { runTurnLoop } from "../agent/loop-engine";
import { createLoopStreaks } from "../loop-detect";

export const BATCH_MAX_WORKERS = 3;
export const BATCH_MIN_WORKERS = 2;
export const BATCH_WORKER_TURN_CAP = 8;
/** At most this many worktree mini-loops run concurrently (8GB honest). */
export const BATCH_CONCURRENCY = 2;

export interface BatchVariant {
  label: string;
  prompt: string;
}

/**
 * The planned variant list plus an honest notice when the model sent more
 * variants than the worker cap — dropped variants are reported, not silently
 * trimmed (the old slice(0, BATCH_MAX_WORKERS) hid them from the parent).
 */
export interface BatchVariantPlan extends Array<BatchVariant> {
  /** Populated only when 1+ valid variants were dropped by the cap. */
  droppedNotice?: string;
}

export interface BatchWorkerResult {
  /** Index within the caller's variants array (contexts/results mapping). */
  idx: number;
  label: string;
  ok: boolean;
  patch: string;
  files: string[];
  turns: number;
  error?: string;
}

export interface BatchConsensus {
  /** 0-based index of the winning variant (merged), or null = no consensus. */
  winner: number | null;
  /** Human explanation for the parent transcript. */
  verdict: string;
}

export interface BatchDeps {
  rootDir: string;
  runId: string;
  /** Text-protocol model call (parent's failover-wrapped helper). */
  callModel: (messages: Array<{ role: string; content: string }>) => Promise<string>;
  /** executeTool bound to the parent's policy — passed through per variant. */
  executeTool: (
    call: { name: string; [k: string]: unknown },
    ctx: WorktreeContext,
    runId: string,
    writtenFiles: Set<string>
  ) => Promise<string>;
  /** Memory pressure gate deployed at the parent. */
  memoryPressureHigh?: () => boolean;
  /** Per-variant progress callback (executor emits run events). */
  onVariantStart?: (idx: number, label: string, dir: string) => void;
  onVariantDone?: (idx: number, result: BatchWorkerResult) => void;
}

const WORKER_SYSTEM = (variant: BatchVariant, batchN: number) =>
  `You are ONE worker in a ${batchN}-way batch_execute: several variants of the same task run in isolated worktrees and a consensus gate keeps only agreement. Execute THIS variant decisively:\n\n${variant.prompt}\n\nRules: make the change with write_file/edit_file as directly as possible; do not nest batch_execute or spawn_subagent; verify only cheaply (read files back); finish with a plain-text summary of exactly what you changed. Your work is merged only if others independently agree with it — write the SAME change a careful reviewer would expect.`

/** Workers get the same tools as the parent minus the parallelism verbs. */
const WORKER_BLOCKED_TOOLS = new Set(["batch_execute", "spawn_subagent", "ask_question", "ask_clarification", "todo_list"]);

export function planBatchVariants(raw: unknown): BatchVariantPlan | null {
  if (!Array.isArray(raw)) return null;
  const variants: BatchVariant[] = [];
  const dropped: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const prompt = String(rec.prompt ?? rec.task ?? "").trim();
    if (!prompt) continue;
    if (variants.length >= BATCH_MAX_WORKERS) {
      if (dropped.length < 5) {
        dropped.push(String(rec.label ?? rec.variant ?? `variant-${i + 1}`).slice(0, 40));
      }
      continue;
    }
    variants.push({ label: String(rec.label ?? rec.variant ?? `variant-${variants.length + 1}`).slice(0, 60), prompt: prompt.slice(0, 4000) });
  }
  if (variants.length < BATCH_MIN_WORKERS) return null;
  const plan = variants as BatchVariantPlan;
  if (dropped.length > 0) {
    plan.droppedNotice = `${dropped.length} more variant(s) beyond the ${BATCH_MAX_WORKERS}-worker cap were NOT executed: ${dropped.join(", ")}${dropped.length >= 5 ? ", …" : ""}`;
  }
  return plan;
}

function normalizedKey(patch: string): string {
  // Sorting lines makes patch equality robust to diff-hunk ordering noise.
  return patch
    .split("\n")
    .filter((l) => l.trim())
    .sort()
    .join("\n");
}

/**
 * Compare the participants and pick the consensus winner (or null). Agreement
 * means: exact/near patch equality (sorted-line canonical form). File-set
 * equality alone is NOT trusted — two workers touching the same files with
 * different edits cancel out, they do not confirm.
 */
export function chooseConsensus(results: BatchWorkerResult[], overCapNotice?: string): BatchConsensus {
  const notice = overCapNotice ? `${overCapNotice}\n` : "";
  const done = results.filter((r) => r.ok && r.patch.trim());
  if (done.length < BATCH_MIN_WORKERS) {
    return { winner: null, verdict: `${notice}batch_execute produced no consensus: fewer than 2 variants completed a diff. Merged nothing — see variant reports.` };
  }
  const groups = new Map<string, number[]>();
  for (let i = 0; i < done.length; i++) {
    const key = normalizedKey(done[i].patch);
    const list = groups.get(key) ?? [];
    list.push(i);
    groups.set(key, list);
  }
  for (const [, members] of groups) {
    if (members.length >= BATCH_MIN_WORKERS) {
      const idx = results.indexOf(done[members[0]]);
      return { winner: idx, verdict: `${notice}batch_execute consensus: ${members.length}/${results.length} variants produced an agreed diff — merged variant "${results[idx].label}".` };
    }
  }
  return { winner: null, verdict: `${notice}batch_execute produced no consensus: ${done.length} variants all differ. Merged nothing — pick the best variant's approach or do it directly; the variant diffs are in the reports.` };
}

export interface BatchOutcome {
  results: BatchWorkerResult[];
  consensus: BatchConsensus;
  /** Context of the winning variant (caller merges + cleans up). */
  winnerContext: WorktreeContext | null;
  /** All worker contexts in creation order (for unified cleanup). */
  contexts: Array<WorktreeContext | null>;
}

/**
 * Run a whole batch to completion. Refuses honestly when callers violate
 * sanity constraints (worker count bounds, memory pressure). Workers run in
 * bounded pairs (BATCH_CONCURRENCY) so 3 variants on an 8GB box never hold 3
 * model streams at once.
 */
export async function runBatchExecute(
  deps: BatchDeps,
  variants: BatchVariantPlan
): Promise<BatchOutcome> {
  const results: BatchWorkerResult[] = [];
  const contexts: Array<WorktreeContext | null> = [];
  const preflight =
    deps.memoryPressureHigh?.() === true
      ? "refused: memory pressure is high — batch_execute skipped"
      : variants.length < BATCH_MIN_WORKERS || variants.length > BATCH_MAX_WORKERS
        ? `refused: batch_execute needs ${BATCH_MIN_WORKERS}-${BATCH_MAX_WORKERS} variants, got ${variants.length}`
        : null;
  if (preflight) {
    return {
      results,
      consensus: { winner: null, verdict: preflight },
      winnerContext: null,
      contexts,
    };
  }

  // Bounded-concurrency pool: BATCH_CONCURRENCY workers advance a shared
  // cursor; a failed worktree creation skips its slot honestly.
  const byIdx: BatchWorkerResult[] = new Array(variants.length);
  let cursor = 0;
  const launchNext = async (): Promise<void> => {
    while (cursor < variants.length) {
      const idx = cursor++;
      const created = await createIsolatedContext(deps.rootDir, `${deps.runId}-b${idx}`).catch((err) => {
        return { __fail: String((err as Error).message) } as unknown as WorktreeContext;
      });
      if ((created as unknown as { __fail?: string }).__fail) {
        byIdx[idx] = {
          idx,
          label: variants[idx].label,
          ok: false,
          patch: "",
          files: [],
          turns: 0,
          error: `variant "${variants[idx].label}" failed: ${(created as unknown as { __fail: string }).__fail}`,
        };
        continue;
      }
      const ctx = created as WorktreeContext;
      contexts[idx] = ctx;
      deps.onVariantStart?.(idx, variants[idx].label, ctx.worktreeDir);
      byIdx[idx] = await runVariantFromContext(deps, variants[idx], idx, variants.length, ctx);
    }
  };
  const starters: Array<Promise<void>> = [];
  for (let s = 0; s < BATCH_CONCURRENCY; s++) starters.push(launchNext());
  await Promise.all(starters);

  for (const r of byIdx) {
    if (r) results.push(r);
  }
  const consensus = chooseConsensus(results, variants.droppedNotice);
  const winnerIdx = consensus.winner != null ? results[consensus.winner]?.idx ?? null : null;
  const winnerContext = winnerIdx != null ? contexts[winnerIdx] ?? null : null;
  return { results, consensus, winnerContext, contexts };
}

/**
 * Worker turn-loop over an ALREADY-CREATED context (runBatchExecute creates
 * contexts so a failed creation skips instead of wedging the slot pool).
 */
async function runVariantFromContext(
  deps: BatchDeps,
  variant: BatchVariant,
  idx: number,
  batchN: number,
  ctx: WorktreeContext
): Promise<BatchWorkerResult> {
  const written = new Set<string>();
  const workerId = ctx.id;
  try {
    const transcript: Array<{ role: string; content: string }> = [
      { role: "user", content: variant.prompt },
    ];

    const exit = await runTurnLoop({
      maxTurns: BATCH_WORKER_TURN_CAP,
      parallelToolLimit: 2,
      loopStreaks: createLoopStreaks(),
      shouldAbort: () => false,
      throwAbort: () => new Error("Batch worker aborted"),
      parseXmlToolCalls: (text) => {
        const calls: Array<Record<string, unknown> & { name: string }> = [];
        try {
          const re = new RegExp('<tool_call>\\s*([\\s\\S]*?)\\s*<\\/tool_call>', "g");
          let m: RegExpExecArray | null;
          while ((m = re.exec(text))) {
            try {
              const parsed = JSON.parse(m[1]);
              if (parsed && typeof parsed.name === "string") calls.push(parsed);
            } catch { /* unparseable call skipped */ }
          }
        } catch { /* regex state safe */ }
        return calls;
      },
      callModel: async () => {
        const text = await deps.callModel([
          { role: "system", content: WORKER_SYSTEM(variant, batchN) },
          ...transcript,
        ]);
        return { content: text, toolCalls: [] };
      },
      onModelOutput: (_turn, out) => {
        transcript.push({ role: "assistant", content: out.content || "" });
      },
      onNoToolCalls: () => null,
      filterToolCalls: (n) => !WORKER_BLOCKED_TOOLS.has(String(n)),
      onLoopTrip: () => "break",
      dispatchCall: async (call): Promise<{ resultXml: string }> => {
        const name = String(call.name);
        let resultXml: string;
        if (WORKER_BLOCKED_TOOLS.has(name)) {
          resultXml = `<tool_result name="${name}">refused: batch workers do not nest parallelism verbs</tool_result>`;
        } else {
          try {
            const out = await deps.executeTool(call, ctx, workerId, written);
            resultXml = `<tool_result name="${name}">${out}</tool_result>`;
          } catch (err) {
            resultXml = `<tool_result name="${name}">error: ${String((err as Error).message).slice(0, 300)}</tool_result>`;
          }
        }
        transcript.push({ role: "user", content: resultXml.slice(0, 6000) });
        return { resultXml };
      },
    });

    const patch = await ctx.patchText().catch(() => "");
    const files = await ctx.diffFiles().catch(() => []);
    const summary = exit.output?.content ?? "";
    const result: BatchWorkerResult = {
      idx,
      label: variant.label,
      ok: patch.trim().length > 0,
      patch,
      files,
      turns: exit.turn + 1,
      error:
        patch.trim().length > 0
          ? undefined
          : `variant "${variant.label}" produced no diff${summary ? ` — agent said: ${summary.slice(0, 200)}` : ""}`,
    };
    deps.onVariantDone?.(idx, result);
    return result;
  } catch (err) {
    const res: BatchWorkerResult = {
      idx,
      label: variant.label,
      ok: false,
      patch: "",
      files: [],
      turns: 0,
      error: `variant "${variant.label}" failed: ${String((err as Error).message).slice(0, 200)}`,
    };
    deps.onVariantDone?.(idx, res);
    return res;
  }
}
