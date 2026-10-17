// background-worker.ts — Runs the tool-calling loop in the background
// Not tied to any React component — survives page navigation
// Features: file deduplication, loop detection, line range display
// Self-review: static quality check + one self-repair turn after the loop

import { recordChange, computeDiff } from "./file-history";
import { analyzeCodeQuality } from "./code-quality-checker";
import { quickQualityCheck } from "./reflection-loop";
import { requestApproval, type ApprovalType } from "./approval-store";
import { planGateBlocks, planGateMessage, approvePlan, rejectPlan, isPlanRejected, clearPlanLatch } from "./plan-gate";
import { classifyRisk } from "./risk-classifier";
import { virtualFS } from "./virtual-fs";
import { beforeToolCall, afterToolCall, onFileWrite, onFileEdit, onTaskStart, onTaskComplete, onTaskFail } from "./plugins/registry";
import { initializePlugins, isPluginEnabled } from "./plugins/initializer";
import { TIMEOUTS, LIMITS, isBlockedCommand } from "./constants";
import { readStream, deduplicateWords, dedupeStreamedChunk, replaceLastStatus, parseToolCalls, normalizeThinkingBlocks, stripRedundantFences, appendTaskAnchor, repairInterleavedReplay, type ToolCall, type StreamResult, type StreamCallbacks } from "./stream-reader";
import {
  createLoopStreaks,
  trackToolTurn,
  buildLoopBreakDirective,
} from "@/lib/agent/contract";
import { SPARC_PLAN_DIRECTIVE, FORCE_TOOLS_DIRECTIVE, FORCE_BROWSER_TOOLS_DIRECTIVE, SAFETY_CONTINUE_DIRECTIVE, qualityReviewDirective, SELF_REVIEW_DIRECTIVE, verificationRepairDirective, browserRepairDirective, truncationContinue, adaptiveFailureDoctrine } from "./master-prompt";
import { recordFailure, recordRepairAttempt, clearFailures } from "./failure-memory";
import { startTaskMeter, recordPromptCall, formatSavingsSummary, logTaskMeter, calibratePromptSizes, computeTaskSavings } from "./prompt-meter";
import { startRubricObservation, recordToolCall, recordLaneOutcome, finishRubricObservation, isRecordingEnabled, formatTrendReport, readTrendHistoryForReport, getObservationMeta } from "./rubric-recorder";
import { getWorkspaceKey, buildFinalizePayload, postRunToLedger, hydrateFailureMemoryFromLedger } from "./run-ledger";
import { buildSystemPrompt } from "./master-prompt";
import { emitStatus, emitActivity, emitPreview, emitCompaction } from "./agent-events";
import { dispatchToolCall, type ToolContext } from "./agent/native-tools";
import { configureCache, searchCache, cacheResponse } from "./semantic-cache";
import {
  createScratchpad,
  seedScratchpad,
  isScratchpadEmpty,
  updateScratchpadSection,
  renderScratchpadBlock,
  type ScratchpadState,
  type ScratchpadSection,
} from "./scratchpad";
import { stampFailedMessage } from "./message-retry";
import { lowMemoryNote } from "./memory-note";
// === Reliability gate pipeline (plan Phase 1, all behind RELIABILITY_* flags) ===
// Every import here is a no-op unless RELIABILITY_GATES=1, so the default
// behaviour of this worker is byte-for-byte unchanged.
import {
  reliabilityGatesEnabled,
  reliabilityEditLockEnabled,
  reliabilityTestLaneEnabled,
  reliabilityBaselineEnabled,
} from "./reliability/flags";
import {
  runGatePipeline,
  captureBaseline,
  formatGateResult,
  type GateExec,
  type WorkspaceBaseline,
} from "./reliability/gates";
import {
  acquireEditLock,
  clearLane,
  isEditLocked,
  recordRefusedWrite,
  releaseEditLock,
} from "./reliability/edit-lock";

let _pluginsInitialized = false;
import {
  startTask,
  updateTaskStatus,
  setDisplayContent,
  appendToDisplayContent,
  completeTask,
  failTask,
  isCurrentTask,
  getCurrentTask,
  getGeneration,
  getTaskAbortSignal,
  setTodos,
  completeTodo,
  clearTodos,
  setScratchpad as setScratchpadText,
  setQuestion,
  answerQuestion,
  bumpStat,
  setFilesChanged,
  type ChatMessage,
} from "./background-chat";

// Types re-exported from stream-reader.ts: ToolCall, StreamResult

// === Token budget & TPM pacing ===
// Groq's free tier for gpt-oss-120b allows 8,000 tokens/MINUTE. The agent's
// stacked prompts + tool results can exceed that (requests of 8.4k-27k were
// observed), so every turn died with HTTP 413. Two protections:
//   1. fitMessagesToBudget - trim older messages before every model call
//   2. reserveTokenWindow - pace requests so a 60s window is never exceeded

const CHARS_PER_TOKEN = 4;

// RATE LIMIT vs CONTEXT WINDOW are different things and were conflated here.
// TPM_LIMIT is a throughput ceiling (tokens per MINUTE) and only paces request
// timing via reserveTokenWindow — it must never size the transcript. Deriving
// the message budget from it produced MSG_BUDGET_TOKENS = 2500, so compaction
// fired after ~3 messages and the divider read "6k -> 2k".
const TPM_LIMIT = 8000; // Groq free tier (gpt-oss-120b, on_demand)
const TPM_SAFETY = 400; // counting-error margin

// Real per-model context window, resolved from the model catalog (the same
// `contextWindow` the picker already shows). There is deliberately NO global
// default window: models here range from ~8k to 400k, so any single hardcoded
// number either starves small-context models or overflows them.
// Unknown/unlisted model -> deliberately small and safe.
const FALLBACK_CONTEXT_TOKENS = 32_000;
// Compact at half the model's window: leaves room for the system prompt, the
// next reply, and MCP tool schemas without ever hitting the hard limit.
const COMPACTION_TRIGGER_RATIO = 0.5;

async function contextWindowForModel(model?: string): Promise<number> {
  if (!model) return FALLBACK_CONTEXT_TOKENS;
  try {
    const { getVerifiedModels } = await import("./model-catalog");
    const { models } = await getVerifiedModels();
    const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
    const hit = models.find((m) => m.id === model) || models.find((m) => m.id === bare);
    const ctx = hit?.contextWindow;
    return typeof ctx === "number" && ctx > 0 ? ctx : FALLBACK_CONTEXT_TOKENS;
  } catch {
    return FALLBACK_CONTEXT_TOKENS;
  }
}
// Calibrate the prompt meter with the REAL master-prompt sizes (once per load).
try {
  const p = await buildSystemPrompt({ mode: "code" });
  const cp = await buildSystemPrompt({ mode: "code", profile: "compact" });
  calibratePromptSizes(p.length, cp.length);
} catch {}

const SYSTEM_PROMPT_TOKENS = 3300; // CODE-mode stack: M3 + techniques + enhanced (added by /api/chat)
const OUTPUT_RESERVE = 1800; // room for the model's reply
// Headroom inside the window for everything that is NOT conversation history:
// the system prompt, the reply, and MCP tool schemas. Sized from THIS model's
// real window (never from the rate limit, and never from a global constant).
const msgBudgetFor = (contextWindow: number) =>
  Math.min(
    Math.floor(contextWindow * COMPACTION_TRIGGER_RATIO),
    contextWindow - SYSTEM_PROMPT_TOKENS - OUTPUT_RESERVE - TPM_SAFETY
  );
const SENT_LOG: { t: number; tokens: number }[] = [];

export function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / CHARS_PER_TOKEN);
}

/**
 * Trim a message list to fit a token budget: cap older messages, drop the
 * oldest ones if still over, and finally cap the last message. Never mutates
 * the input - returns a new array.
 *
 * LIVE-VALIDATED (run 5): a mid-tag cut with no explanation made the model
 * believe the FILE was truncated — it re-read the same file 3× and nearly
 * shipped "No changes were necessary" based on the confusion. Caps now break
 * at a line boundary and say exactly what was cut and why.
 */
export function fitMessagesToBudget(
  messages: { role: string; content: string }[],
  budgetTokens: number = msgBudgetFor(FALLBACK_CONTEXT_TOKENS)
): { role: string; content: string }[] {
  const out = messages.map(m => ({ ...m }));
  if (out.length === 0) return out;
  const total = () => out.reduce((s, m) => s + estimateTokens(m.content), 0);

  /** Cut at a line boundary and mark exactly what the cut was. */
  const capWithMarker = (content: string, charCap: number, marker: string) => {
    let cut = content.slice(0, charCap);
    const lastNl = cut.lastIndexOf("\n");
    if (lastNl > charCap * 0.5) cut = cut.slice(0, lastNl); // keep ≥50% of the head
    return cut + marker;
  };

  // 1. Cap every message except the last (tool results & old turns)
  const OLDER_CAP = 800; // tokens
  for (let i = 0; i < out.length - 1; i++) {
    if (estimateTokens(out[i].content) > OLDER_CAP) {
      out[i].content = capWithMarker(
        out[i].content,
        OLDER_CAP * CHARS_PER_TOKEN,
        "\n…[OLDER MESSAGE SHORTENED FOR CONTEXT BUDGET — the middle was cut here, the FILE ITSELF is complete]"
      );
    }
  }
  // 2. Drop oldest messages while still over budget (keep at least 2)
  while (total() > budgetTokens && out.length > 2) {
    out.splice(0, 1);
  }
  // 3. Finally cap the last message if needed
  if (total() > budgetTokens) {
    const last = out[out.length - 1];
    const rest = total() - estimateTokens(last.content);
    const allow = Math.max(500, budgetTokens - rest);
    if (estimateTokens(last.content) > allow) {
      last.content = capWithMarker(
        last.content,
        allow * CHARS_PER_TOKEN,
        "\n…[TOOL OUTPUT SHORTENED FOR CONTEXT BUDGET — the middle was cut here, the FILE ITSELF is complete; use line ranges to re-check specifics]"
      );
    }
  }
  return out;
}

/**
 * Pace requests so the tokens sent in any rolling 60s window stay under the
 * provider's TPM limit. Sleeps (with a status update) when the window is full.
 */
  async function reserveTokenWindow(tokens: number, abortSignal?: AbortSignal | null): Promise<void> {
    const now = Date.now();
    for (let i = SENT_LOG.length - 1; i >= 0; i--) {
      if (now - SENT_LOG[i].t > 60_000) SENT_LOG.splice(i, 1);
    }
    const used = SENT_LOG.reduce((s, e) => s + e.tokens, 0);
    const overflow = used + tokens - (TPM_LIMIT - TPM_SAFETY);
    if (overflow > 0) {
      const waitMs = Math.min(65_000, Math.ceil((overflow / TPM_LIMIT) * 60_000) + 1_000);
      updateTaskStatus("streaming", `Rate limit: waiting ${Math.ceil(waitMs / 1000)}s for the token window to reset...`);
      // The sleep had no abort check, so pressing Stop during a rate-limit
      // wait did not unwind for up to 65s. Wait in slices and bail on abort.
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        if (abortSignal?.aborted) return;
        await new Promise((r) => setTimeout(r, Math.min(250, deadline - Date.now())));
      }
      if (abortSignal?.aborted) return;
      // The old code pushed unconditionally after the wait, so two concurrent
      // runs could both observe overflow, both sleep, and both push - putting
      // up to 2x the intended tokens in one 60s window, which is exactly the
      // HTTP 413 storm this function exists to prevent. It also stamped the
      // entry AFTER the sleep, attributing it to a later window than the one
      // that was checked.
    }
    // Reserve against the post-wait truth.
    const postWaitUsed = SENT_LOG.reduce((s, e) => (Date.now() - e.t <= 60_000 ? s + e.tokens : s), 0);
    // Still full: do NOT reserve optimistically (that is what caused double-counts).
    // Fail open - the caller proceeds and the provider's 413 path already has a
    // retry with backoff, which is better than deadlocking here.
    if (postWaitUsed + tokens > TPM_LIMIT) return;
    SENT_LOG.push({ t: Date.now(), tokens });
  }

const TOKEN_LIMIT_RE = /tokens per minute|Request too large|\b413\b/i;

/**
 * Model call with budget fitting + pacing + one adaptive retry on TPM 413s.
 * Mirrors readStream's signature - all worker model calls go through here.
 */

/**
 * State that belongs to ONE run, not to the module.
 *
 * These four were module-level `let`s, written when a run started and read
 * inside callModel with network awaits in between. Two overlapping runs (queue
 * concurrency is 3, and the detached lanes run in parallel) therefore wrote
 * into each other's state:
 *
 *  - anchorTaskMessage: run B set the anchor mid-run, so run A's next callModel
 *    appended B's sentence labelled "ORIGINAL TASK - never ask for
 *    clarification about it". Silent prompt poisoning.
 *  - taskCompactor: ONE shared instance holding {coveredCount, summary,
 *    fingerprint}. B's reset() landed during A's summarizer request, A's
 *    completion wrote its summary back, and B then folded its new tail onto A's
 *    summary - so B's model context literally contained the other run's
 *    compressed history.
 *  - lastCompactedThrough / taskMemoriesUsed: one run's counters attributed to
 *    the other.
 *
 * They now live in a RunState created per run and threaded through callModel,
 * so an overlap cannot reach another run's state at all.
 */
interface RunState {
  /** The original task text - keeps the task anchored in the trimmed context. */
  anchorTaskMessage: string;
  /** Lazily created per-run summarizing compactor (see compaction.ts). */
  taskCompactor: import("./compaction").TranscriptCompactor | null;
  /** Eviction high-water mark, so one logical compaction emits one divider. */
  lastCompactedThrough: number;
  /** How many memory entries were injected, for the run record. */
  taskMemoriesUsed: number;
}

function createRunState(userMessage: string): RunState {
  return {
    anchorTaskMessage: userMessage,
    taskCompactor: null,
    lastCompactedThrough: 0,
    taskMemoriesUsed: 0,
  };
}

// Semantic response cache — opt-in via env (default off to preserve behavior).
// Set SEMANTIC_CACHE=1 to enable. Cache is in-memory, per-process, TTL 24h.
let cacheEnabled = process.env.SEMANTIC_CACHE === "1";
if (cacheEnabled) {
  try { configureCache({ enabled: true }); } catch {}
}

/**
 * Pull the human-readable summary out of a compacted transcript.
 *
 * `compactTranscript` replaces the evicted prefix with a single
 * `<context_so_far>…</context_so_far>` block (compaction.ts). The divider wants
 * that body on its own — showing a user the raw wrapper tags would leak an
 * implementation detail into the UI. Returns null when the shape is unexpected,
 * so the divider can say "no summary captured" instead of printing markup.
 */
function summarizeForDisplay(compacted: Array<{ content?: string }>): string | undefined {
  const first = compacted?.[0]?.content ?? "";
  const m = first.match(/<context_so_far>\s*([\s\S]*?)\s*<\/context_so_far>/i);
  const body = (m?.[1] ?? "").trim();
  return body.length > 0 ? body : undefined;
}
// The task object carries optional telemetry fields beyond the core interface.
type BackgroundTaskLike = { memoriesUsed?: number };
async function callModel(
  apiMessages: { role: string; content: string }[],
  runState: RunState,
  conversationId: string | null,
  callbacks: StreamCallbacks,
  mode: string,
  images: string[],
  signal?: AbortSignal | null,
  effort?: string,
  profile: "full" | "compact" = "full",
  meterInfo?: { taskId: string; turn: number; why: string },
  model?: string,
  mcpRemotes?: Array<{ id: string; label: string; url: string; auth: "oauth" | "bearer" | "none"; tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }>
): Promise<StreamResult> {
  const estimate = (ms: { role: string; content: string }[]) => ms.reduce((s, m) => s + estimateTokens(m.content), 0);
  // Task anchor: trimming drops oldest-first, which on long loops evicted the
  // original task entirely (live run: the model asked "what would you like me
  // to help with?" mid-build). The anchor rides on the LAST message — the one
  // message the budget can never drop.
  const anchored = appendTaskAnchor(apiMessages, runState.anchorTaskMessage);
  // Resolved BEFORE the truncation below, for THIS model's real context window.
  //
  // It used to be resolved AFTER, and `fitMessagesToBudget(anchored)` was called
  // with the default budget — msgBudgetFor(FALLBACK_CONTEXT_TOKENS) ≈ 16k. That
  // default then survived whenever compaction returned null (transcript under
  // the 0.8 trigger of the REAL budget), so a 1M-window model sent at most ~16k
  // tokens of history: lossy truncation instead of summarization, and with the
  // transcript already shrunk, compaction could never reach its trigger to
  // recover it. Resolving first makes the fallback path use the same budget the
  // compaction path already used.
  const MSG_BUDGET_TOKENS = msgBudgetFor(await contextWindowForModel(model));
  // Summarizing compaction BEFORE truncation: when the transcript outgrows
  // the budget, evicted messages become a <context_so_far> summary instead of
  // being dropped. Incremental state = one bounded summary call per eviction.
  // Any failure falls back to fitMessagesToBudget below — never blocks a task.
  let fitted = fitMessagesToBudget(anchored, MSG_BUDGET_TOKENS);
  try {
    const { createTranscriptCompactor } = await import("./compaction");
    runState.taskCompactor ||= createTranscriptCompactor(async (prompt, maxTokens) => {
      const res = await readStream(
        [{ role: "user", content: prompt }],
        null,
        { onChunk: () => {}, onThinking: () => {} },
        mode,
        [],
        signal,
        effort,
        "compact"
      );
      void maxTokens; // compact profile + readStream caps handle the budget
      return res.content || "";
    });
    // Resolved once per callModel for THIS model's real context window.
    const compacted = await runState.taskCompactor.compact(anchored, MSG_BUDGET_TOKENS, signal);
    if (compacted) {
      fitted = fitMessagesToBudget(compacted, MSG_BUDGET_TOKENS);
      emitActivity({ type: "status", message: "Context compacted — earlier turns summarized to stay under the token budget", agent: "coder" });
      // Structured companion to the status line: the timeline renders a
      // collapsible marker with the real before/after numbers, which the flat
      // status string cannot carry.
      //
      // Token figures are ESTIMATES from the same chars/4 heuristic the
      // prompt meter uses (see below) — the divider renders them "~"-prefixed
      // for that reason.
      //
      // Gated on the eviction advancing: callModel runs again on every tool
      // turn and again for review/repair, and each pass compacts a little more.
      // One logical compaction should read as ONE divider in the timeline.
      const evictedNow = anchored.length - compacted.length;
  if (evictedNow > runState.lastCompactedThrough) {
    runState.lastCompactedThrough = evictedNow;
        const charsToTokens = (msgs: Array<{ content?: string }>) =>
          Math.round(msgs.reduce((sum, m) => sum + (m.content || "").length, 0) / 4);
        emitCompaction({
          tokensBefore: charsToTokens(anchored),
          tokensAfter: charsToTokens(fitted),
          mode: "automatic",
          summary: summarizeForDisplay(compacted),
        });
      }
    }
  } catch {}
  // Meter BEFORE reserving: system block is server-side (profile chosen from
  // body), so we record the estimated system size + actual context size.
  if (meterInfo) {
    try {
      const { getPromptSizes } = await import("./prompt-meter");
      const sizes = getPromptSizes();
      const contextChars = fitted.reduce((s, m) => s + (m.content || "").length, 0);
      // C10: MCP schemas ride in the tools array every call — count them on
      // the system side via the shared builder's schemaChars. Include legacy
      // remotes (localStorage) so the meter accounts for them too.
      const { loadRemotes } = await import("./mcp/registry");
      const { buildMcpRoster } = await import("./mcp/tool-builder");
      const toolSchemaChars = buildMcpRoster(
        loadRemotes().flatMap((r) =>
          (r.tools ?? []).map((t) => ({
            server: r.id,
            name: t.name,
            description: t.description ?? "",
            inputSchema: t.inputSchema,
            annotations: t.annotations,
          }))
        )
      ).schemaChars;
      recordPromptCall({
        taskId: meterInfo.taskId,
        turn: meterInfo.turn,
        profile,
        mode,
        effort,
        systemChars: profile === "compact" ? sizes.compact : sizes.full,
        contextChars,
        toolSchemaChars,
        why: meterInfo.why,
      });
    } catch {}
  }
  // Send legacy-lane remotes to /api/chat so the server-side prompt builder
  // can include them in the MCP section (the model needs to KNOW the tools
  // exist to call them — dispatch alone isn't enough).
  let sendMcpRemotes = mcpRemotes;
  try {
    const { loadRemotes } = await import("./mcp/registry");
    const remotes = loadRemotes();
    if (remotes.length > 0) {
      sendMcpRemotes = remotes.map((r) => ({
        id: r.id,
        label: r.label,
        url: r.url,
        auth: r.auth,
        tools: r.tools?.map((t) => ({ name: t.name, description: t.description ?? undefined, inputSchema: t.inputSchema ?? undefined })) ?? undefined,
      }));
    }
  } catch {}
  await reserveTokenWindow(estimate(fitted), signal);
  // Transient-blip retry: LIVE-VALIDATED (run 4) — a dropped connection
  // ("fetch failed") on call #2 killed an otherwise-healthy task after it had
  // already produced its plan. One retry with a short backoff covers both
  // this and the token-window pressure path. Abort never retries.
  const attempt = async (msgs: { role: string; content: string }[]): Promise<StreamResult> => {
    // Semantic cache: check for similar past query (opt-in via SEMANTIC_CACHE=1).
    // We hash the last user message as the query key.
    let cacheHit: { response: string; toolsUsed: string[] } | null = null;
    let cacheKey = "";
    if (cacheEnabled) {
      try {
        const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content || "";
        if (lastUser) {
          cacheKey = lastUser.slice(0, 500);
          const hit = searchCache(cacheKey);
          if (hit) {
            cacheHit = { response: hit.response, toolsUsed: hit.toolsUsed };
            callbacks?.onChunk?.(hit.response);
            return { content: hit.response, thinking: "", toolCalls: [] };
          }
        }
      } catch {}
    }

    try {
      const result = await readStream(msgs, conversationId, callbacks, mode, images, signal, effort, profile, { model, mcpRemotes: sendMcpRemotes });
      // Cache successful response (if we have a cache key and content).
      if (cacheEnabled && cacheKey && result.content) {
        try { cacheResponse(cacheKey, result.content, cacheHit?.toolsUsed || []); } catch {}
      }
      return result;
    } catch (err) {
      if (signal?.aborted) throw err;
      const { isTransientError } = await import("./retry");
      if (!isTransientError(err)) throw err;
      await new Promise((r) => setTimeout(r, 1500));
      updateTaskStatus("tool_executing", "Connection blip — retrying…");
      emitActivity({ type: "status", message: "Provider blip — retrying once", agent: "coder" });
      const retryResult = await readStream(msgs, conversationId, callbacks, mode, images, signal, effort, profile, { model, mcpRemotes: sendMcpRemotes });
      if (cacheEnabled && cacheKey && retryResult.content) {
        try { cacheResponse(cacheKey, retryResult.content, []); } catch {}
      }
      return retryResult;
    }
  };
  try {
    return await attempt(fitted);
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    if (!TOKEN_LIMIT_RE.test(msg) || signal?.aborted) throw err;
    // The failed attempt still burned window tokens - account for it, then
    // retry once with a tighter budget (aggressively trimmed context).
    SENT_LOG.push({ t: Date.now(), tokens: OUTPUT_RESERVE + 1000 });
    const tighter = fitMessagesToBudget(apiMessages, Math.floor(MSG_BUDGET_TOKENS / 2));
    await reserveTokenWindow(estimate(tighter), signal);
    return await attempt(tighter);
  }
}

// === Filesystem access ===

// Re-export event functions so existing imports from background-worker still work
export { onPreviewEvent, onAgentStatus } from "./agent-events";
export type { PreviewEvent } from "./agent-events";

// === Auto-verification (closed-loop autonomy) ===============================
// After the tool loop + self-review, the worker compile-checks the workspace
// (npx tsc --noEmit via /api/agent/exec) and feeds failures back to the model
// for repair — up to MAX_REPAIR_ROUNDS rounds — so tasks end VERIFIED, not
// just written. Code/plan mode only, and only when a workspace folder is open
// (otherwise exec would typecheck Orplex's own directory).

export const VERIFY_COMMAND = "npx tsc --noEmit";
export const VERIFY_TIMEOUT_MS = 120_000;
export const MAX_REPAIR_ROUNDS = 2;

/**
 * True when the task's writes look like UI work worth browser-verifying:
 * component/page/style files in a web project. Configs/READMEs alone don't
 * trigger the (comparatively expensive) Playwright pass.
 */
export { looksLikeUiWork } from "./ui-paths";
import { looksLikeUiWork, BROWSER_VERIFY_PORT, pickDevCommand } from "./ui-paths";
import { apiFetch } from "@/lib/api-base";

const TYPECHECK_ERROR_RE = /\berror TS\d+:/;

// === Deep orchestration (deterministic strategy router) ====================
// Runs server-side via /api/agent/orchestrate (the transport needs API keys
// that must never reach the browser). The route maps legacy op names onto the
// strategy router; the worker executes returned tool calls through its normal
// audited write path. ONE planning call per task (was up to 5 through the
// SPARC→ToT→blueprint waterfall).
const ORCHESTRATE_URL = `/api/agent/orchestrate`;

async function runOrchestration<T = any>(op: string, payload: Record<string, unknown>): Promise<T | null> {
  // 330s > the route's own maxDuration (300s) — the server always gets to
  // answer first. LIVE-VALIDATED: at 280s the client aborted 2s before SPARC
  // finished (5 sequential NVIDIA calls ≈ 282s), wasting the entire run.
  try {
    const res = await fetch(ORCHESTRATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, ...payload }),
      signal: AbortSignal.timeout(330_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.ok ? (data as T) : null;
  } catch {
    return null;
  }
}

/** Execute orchestrator-returned write_file calls through the audited path. */
async function executeOrchestratedWrites(
  toolCalls: Array<Partial<ToolCall>>,
  ctx: {
    totalWrites: number;
    writtenFiles: Map<string, string>;
    bumpStat: (s: "toolCalls") => void;
    setFilesChanged: (n: number) => void;
    label: string;
    /** Stop must interrupt a batch mid-flight. */
    abortSignal?: AbortSignal | null;
    /** Abandon the batch when a newer run has claimed the task slot. */
    isStale?: () => boolean;
  }
): Promise<number> {
  let count = 0;
  for (const call of toolCalls) {
    if (call.name !== "write_file" || !call.path || call.content === undefined) continue;
    // This loop had no abort check and the call site sat outside the try/catch
    // and every other abort guard, so pressing Stop mid-batch left files 3..N
    // still being written while the "Stopped" note was already on screen.
    if (ctx.abortSignal?.aborted) break;
    if (ctx.isStale?.()) break;
    updateTaskStatus("tool_executing", `${ctx.label}: writing ${call.path}…`);
    emitActivity({ type: "file", message: `${ctx.label}: ${call.path}`, agent: "coder" });
    try {
      let ok = false;
      if (_writeFile) {
        const prevContent = _readFile ? await _readFile(call.path).catch(() => null) : null;
        const hasPrev = prevContent && !prevContent.startsWith("[Error");
        recordChange(call.path, hasPrev ? prevContent : null, call.content);
        ok = await _writeFile(call.path, call.content);
      } else {
        ok = virtualFS.writeFile(call.path, call.content);
      }
      if (ok) {
        count++;
        ctx.bumpStat("toolCalls");
        ctx.totalWrites += 1;
        ctx.setFilesChanged(ctx.totalWrites);
        ctx.writtenFiles.set(call.path, call.content);
      }
    } catch {
      // Orchestrator-planned write failed — keep going; the model's own
      // refinement pass will notice the missing file and rewrite it.
    }
  }
  return count;
}

/** Extract deduped `error TSxxxx` lines from tsc output. "" when clean. */
export function summarizeTypecheckOutput(raw: string, maxErrors = 8): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of (raw || "").split("\n")) {
    // No tsconfig / no TS inputs — this project has nothing to typecheck.
    if (/TS18003/.test(line)) continue;
    if (!TYPECHECK_ERROR_RE.test(line)) continue;
    const trimmed = line.trimEnd();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= maxErrors) break;
  }
  return out.join("\n");
}

/** Repair prompt fed back to the model after a failed verification round. */
export function buildVerificationRepairPrompt(findings: string, files: string[]): string {
  // Text lives in the master prompt (single source of truth).
  return verificationRepairDirective(findings, files);
}

/**
 * Commands that start long-running servers. These must go through the
 * detached serve lane (/api/agent/serve), never blocking exec — a server
 * never exits, so exec would kill it at the timeout and orphan the child.
 */
export function isServerCommand(command: string): boolean {
  return /(^|\s)(npx\s+serve|serve\s|npm\s+run\s+dev|npm\s+run\s+start|npm\s+start\b|next\s+dev|next\s+start|vite(\s|$)|python3?\s+(-\w+\s+)*-?m\s+http\.server|flask\s+run|uvicorn(\s|$)|php\s+-S|http-server(\s|$)|json-server(\s|$)|live-server(\s|$))/.test(command);
}

/**
 * Detect EADDRINUSE/EACCES port conflicts in command output and append an
 * actionable hint (find the PID via netstat, or use the serve lane).
 */
export function diagnosePortConflict(command: string, output: string): string {
  const o = (output || "").toLowerCase();
  const portMatch =
    command.match(/(?:-l|--listen|-p|--port)\s+(\d{2,5})/) ||
    command.match(/http\.server\s+(\d{2,5})/) ||
    command.match(/:\s?(\d{4,5})\b/);
  const port = portMatch ? portMatch[1] : null;
  const isConflict = /eaddrinuse|address already in use|port is already|listen eacces|permission denied/.test(o);
  if (!isConflict) return "";
  if (port) {
    return `\n\n[HINT] Port ${port} is taken — likely a zombie server from an earlier attempt. Find and kill it: run_command({ command: "netstat -ano | findstr :${port}" }) then run_command({ command: "taskkill /PID <pid> /T /F" }) (Windows) — or serve on another port.`;
  }
  return "\n\n[HINT] The port is taken by an older process — pick a different port or stop the old server first.";
}

/**
 * Poll the task store for the user's answer to a pending question (set via
 * setQuestion). Shared by ask_question and the safety-limit continue prompt.
 */
function waitForAnswer(timeoutMs = 300_000): Promise<string> {
  // Capture the WAITING task's id: a newer task starting mid-wait must not
  // resolve this waiter with the wrong task's answer.
  const waitingId = getCurrentTask()?.id;
  return new Promise((resolve) => {
    let resolved = false;
    const done = (value: string) => {
      if (resolved) return;
      resolved = true;
      clearInterval(check);
      clearTimeout(timer);
      resolve(value);
    };
    const check = setInterval(() => {
      const bg = getCurrentTask();
      if (!bg || bg.id !== waitingId || bg.status === "done" || bg.status === "error") {
        done("(task cancelled)");
        return;
      }
      if (bg.question?.answered) {
        done(bg.question.answer || "");
      }
    }, 500);
    const timer = setTimeout(() => {
      done("(timed out)");
    }, timeoutMs);
  });
}

// === Filesystem access ===

let _readFile: ((path: string) => Promise<string>) | null = null;
let _writeFile: ((path: string, content: string) => Promise<boolean>) | null = null;
let _editFile: ((path: string, oldText: string, newText: string) => Promise<boolean>) | null = null;
let _fileTree: any[] = [];
let _fileContents: Record<string, string> = {};
let _directoryName = "";

export function setFileSystemAccess(
  readFile: (path: string) => Promise<string>,
  writeFile: (path: string, content: string) => Promise<boolean>,
  editFile: (path: string, oldText: string, newText: string) => Promise<boolean>,
  fileTree: any[],
  fileContents: Record<string, string>,
  directoryName: string
) {
  _readFile = readFile;
  // Only expose write/edit when a folder is actually open — otherwise calls
  // hit the File System Access API with no handle and throw "No file handle
  // found", surfacing as a console error + Next.js overlay.
  _writeFile = directoryName ? writeFile : null;
  _editFile = directoryName ? editFile : null;
  _fileTree = fileTree;
  _fileContents = fileContents;
  _directoryName = directoryName;
}

function listFilesUnderPath(path: string): string {
  const results: string[] = [];
  const walk = (ns: any[]) => {
    for (const n of ns) {
      if (n.kind === "file" && (path === "" || path === "." || n.path.startsWith(path))) {
        results.push(n.path);
      }
      if (n.kind === "directory" && n.children) walk(n.children);
    }
  };
  walk(_fileTree);
  return results.length > 0 ? results.join("\n") : "No files found at that path.";
}

// searchCode over _fileContents was removed (Freebuff model): search runs
// server-side on disk via /api/agent/grep (ripgrep → git grep → node scan),
// dispatched from agent/native-tools.ts — not over the renderer's hot-set.

// readStream is imported from stream-reader.ts
// Tool calls are returned as part of StreamResult.toolCalls

// === Build workspace context ===

async function buildContext(userMessage: string): Promise<string> {
  // Use M3-aware context builder — leverages 1M token context window
  const { buildM3Context } = await import("./context-builder");
  const { context } = buildM3Context(_fileTree, _fileContents, userMessage, _directoryName);
  return context;
}

// === File content preview (for status display) ===

function getContentPreview(content: string, maxLines: number = 3): string {
  const lines = content.split("\n").filter(l => l.trim());
  const preview = lines.slice(0, maxLines).join(" ").slice(0, 80);
  return preview + (lines.length > maxLines ? "…" : "");
}

// === Main background loop ===

// Unlimited within reason — streak-based loop detection (loop-detect.ts:
// identical-call repeats + state-changing same-tool runs, both measured
// in-a-row) plus MAX_TOTAL_WRITES and the hard turn cap below stop runaway
// loops. The cap exists so a stuck model can't burn the TPM window forever;
// the interactive safety-limit flow (ask user → reset counters) still
// governs most sessions.
const MAX_TOOL_TURNS = 120;
const MAX_TOTAL_WRITES = 15; // Safety cap on total file writes per task

// === Complexity detection — flags complex tasks for the plan-first directive ===
function isComplexTask(userMessage: string): boolean {
  const lower = userMessage.toLowerCase();
  // Multi-file / full-project requests
  const complexPatterns = /\b(build|create|make|generate|implement|develop|scaffold|set\s?up)\b.*\b(full|complete|production|entire|whole|complex|multi|enterprise|website|app|application|dashboard|platform|system)\b/i;
  // Explicit orchestration trigger (kept for plan-first gating only)
  const multiAgentTrigger = /\b(multi.?agent|@multi|@agents|orchestrat|parallel)\b/i;
  // Very long prompts with multiple requirements
  const hasMultipleRequirements = userMessage.split(/\n|\.|;|\band\b/).filter(s => s.trim().length > 10).length >= 5;
  return complexPatterns.test(userMessage) || multiAgentTrigger.test(userMessage) || hasMultipleRequirements;
}

export async function runInBackground(
  userMessage: string,
  conversationId: string | null,
  priorMessages: ChatMessage[],
  mode: string = "ask",
  imageDataUrls: string[] = [],
  fullPrompt?: string,
  effort?: string,
  // opts.model: model id picked in the prompt bar — honored server-side by
  // /api/chat (only providers whose model matches serve the request).
  // Auto-verification defaults ON; pass { autoVerify: false } to disable.
  opts: {
    autoVerify?: boolean;
    model?: string;
    /** Legacy-lane MCP remotes to advertise to the server-side prompt builder. */      mcpRemotes?: Array<{ id: string; label: string; url: string; auth: "oauth" | "bearer" | "none"; tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }>;
  } = {}
) {
  const autoVerify = opts.autoVerify !== false;
  const selectedModel = opts.model;
  // Plan-first directive for complex tasks (SPARC gate enforces todo_list
  // before writes — the former @multi → multi-agent-graph detour is gone:
  // the graph's tool calls never executed, so it only burned turns).
  const sparcDirective = mode !== "ask" && isComplexTask(userMessage) ? SPARC_PLAN_DIRECTIVE : null;


  // Only add workspace context to the FIRST message (no prior messages).
  // fullPrompt carries the typed text + pasted/attached file content from
  // ChatInput; workspace context wraps around it instead of replacing it.
  const isFirstMessage = priorMessages.length === 0;
  const basePrompt = fullPrompt ?? userMessage;
  let contentWithFiles = basePrompt;
  if (isFirstMessage) {
    try {
      contentWithFiles = await buildContext(basePrompt);
    } catch {}
  }
  if (sparcDirective) contentWithFiles = `${sparcDirective}\n\n${contentWithFiles}`;

  // === Claim the task slot FIRST ==========================================
  // This used to happen AFTER the orchestration await below, which can park
  // for up to 330s (AbortSignal.timeout(330_000) in runOrchestration). During
  // that window nothing owned the task slot, so a second send could claim it
  // and start streaming - and when the FIRST run finally woke up it reached
  // the cancel-previous logic, found the SECOND (newer) task streaming, and
  // aborted it. The user saw their newest message die with an empty bubble,
  // while the older run answered it. Claiming before the await closes the
  // window; the generation guard below closes the residual race.
  const { cancelTask } = await import("./background-chat");
  const existing = getCurrentTask();
  if (existing && (existing.status === "streaming" || existing.status === "tool_executing" || existing.status === "awaiting_approval")) {
    cancelTask({ abort: true });
  }

  const userMsg: ChatMessage = {
    role: "user",
    content: userMessage,
    time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
  };

  const allMessages = [...priorMessages, userMsg];
  const taskId = startTask(conversationId, userMessage, allMessages, mode, selectedModel);
  // Our generation. If anything else claims the slot while we are awaiting,
  // this run must unwind instead of writing into the newer task's store.
  const myGeneration = getGeneration();
  startRubricObservation(taskId, userMessage, mode);
  // Reap run-sync records for tasks that ended via an early return and so can
  // never report a terminal status (see sweepDeadTaskRecords).
  try {
    const { sweepDeadTaskRecords } = await import("./run-sync");
    sweepDeadTaskRecords(new Set([taskId]));
  } catch {} // test-mode rubric observation (no-op unless TEST_MODE/live session)

  // === Deep orchestration attempt (code/plan mode, complex tasks) ==========
  // ONE deterministic router call: it picks scaffold | branch-compare |
  // implement | plan from the task shape and produces write_file calls the
  // loop below executes through the audited path. If the route is unavailable
  // the plan-first directive stays in place and the normal loop does the work.
  let orchestrationSummary = "";
  let orchestrationLabel = "Strategy";
  let orchestratedWrites = 0;
  let orchestratedToolCalls: Array<Partial<ToolCall>> = [];
  if (sparcDirective) {
    // Only now safe to touch the shared status: the task slot is ours.
    updateTaskStatus("streaming", "Planning with the strategy router…");
    const routed = await runOrchestration("auto", {
      task: basePrompt,
      context: contentWithFiles.slice(0, 20_000),
      existingFileCount: _fileTree.reduce((n: number, node: any) => n + (node.kind === "file" ? 1 : 0), 0),
    });
    // A newer send may have claimed the slot during those up-to-330s. Unwind
    // rather than continue writing into another run's task.
    if (myGeneration !== getGeneration()) {
      return;
    }
    if (routed && Array.isArray(routed.toolCalls) && routed.toolCalls.length > 0) {
      orchestrationLabel = String(routed.strategy || "strategy").toUpperCase();
      orchestrationSummary = `[${orchestrationLabel}] ${routed.summary || ""}`.trim();
      contentWithFiles = `${orchestrationSummary}\n\n${basePrompt}`;
      orchestratedToolCalls = routed.toolCalls;
    }
    // Router unavailable/empty → the SPARC plan-first directive still gates
    // writes until the model has planned via todo_list, so nothing is lost.
  }

  // Rubric/meter data captured during the run; readable from the error path too.
  let savingsPct: number | null = null;
  let modelCallCount = 0;
  // Cross-restart learning: pull this workspace's unresolved failure
  // signatures from the persistent ledger into the Failure Doctrine BEFORE
  // the first model call. Best-effort — an unreachable server teaches nothing
  // and breaks nothing.
  hydrateFailureMemoryFromLedger(getWorkspaceKey(_directoryName)).catch(() => {});
  // Per-task prompt-token meter (full vs compact savings — see prompt-meter)
  startTaskMeter(taskId, mode);
  // The abort signal for THIS task — Stop aborts it and readStream unwinds
  const abortSignal = getTaskAbortSignal();

  // User pressed Stop while we were building context (before startTask)
  if (abortSignal?.aborted) return;

  // Initialize plugins once
  if (!_pluginsInitialized) {
    _pluginsInitialized = true;
    initializePlugins().catch(() => {});
  }

  // Fire plugin hooks
  // Per-run state, created fresh for THIS run and threaded into every
  // callModel below. Previously these were module-level `let`s, so overlapping
  // runs shared one task anchor and one compactor - see the RunState doc.
  const runState = createRunState(userMessage);
  getCurrentTask() && ((getCurrentTask() as BackgroundTaskLike).memoriesUsed = 0);
  onTaskStart(userMessage).catch(() => {});

  // Build API messages — the msg that carries attachments gets the enriched
  // content (workspace context or pasted-file blocks); the rest stay plain.
  // For the first message that's the opening user msg; for follow-ups it's
  // the message the user just sent (last in the list).
  let apiMessages: { role: string; content: string }[] = allMessages.map((m, idx) => {
    const isEnhancedUserMsg =
      m.role === "user" &&
      ((isFirstMessage && idx === 0) || (!isFirstMessage && idx === allMessages.length - 1));
    return { role: m.role, content: isEnhancedUserMsg ? contentWithFiles : m.content };
  });

  let lastStreamedContent = "";
  let fullDisplayContent = "";
  // Set when the model answered empty (no text, no tool calls) — the empty
  // bubble gets [FAILED]-stamped at finalize so Retry is offered.
  let failedEmptyResponse = false;

  // NOTE (consolidation): the semantic-cache hint lane was removed — similar
  // past tasks are surfaced through the workspace-learnings bucket + run
  // ledger instead of a fourth memory mechanism. See semantic-cache.ts.

  // === Adaptive Failure Doctrine: if the LAST task ended in verification
  // failures, seed this fresh task with the real evidence so the model
  // doesn't repeat the identical mistake (the doctrine becomes situational,
  // not generic). Only on the first message — follow-ups have live history.
  if (isFirstMessage) {
    try {
      const failureCtx = await adaptiveFailureDoctrine();

      if (failureCtx) {
        apiMessages.push({ role: "user", content: failureCtx });
        fullDisplayContent += `\n*[Failure context from previous task injected — the agent will avoid the last failure's path]*\n`;
        setDisplayContent(fullDisplayContent);
      }
    } catch {}
    // Workspace learnings: evidence-backed memories from previous verified
    // tasks in this workspace (stack, patterns, user decisions). Fetched via
    // the memory API (the browser never touches the DB directly) and injected
    // once per task — hints, not doctrine.
    try {
      const { retrieveMemoryBlockViaApi } = await import("./workspace-memory-client");
      const memoryBlock = await retrieveMemoryBlockViaApi(_directoryName, userMessage);
      if (memoryBlock) {
        apiMessages.push({ role: "user", content: memoryBlock });
        fullDisplayContent += `\n*[Workspace learnings applied]*\n`;
        setDisplayContent(fullDisplayContent);
        // Count injected entries so the run record can show retrieval firing
        // (the block is one "- [TAG] ..." line per memory).
    runState.taskMemoriesUsed = memoryBlock.split("\n").filter((l) => l.startsWith("- [")).length;
    const t = getCurrentTask();
    if (t) (t as BackgroundTaskLike).memoriesUsed = runState.taskMemoriesUsed;
      }
    } catch {}
    // Playbook: evidence-backed learnings from previous VERIFIED runs.
    // Fetched via the playbook API (the browser never touches the DB
    // directly) and injected once per task — hints, not doctrine.
    try {
      const res = await apiFetch(`/api/playbook?q=${encodeURIComponent(userMessage.slice(0, 500))}`);
      const data = (await res.json()) as { results?: Array<{ pattern: string; content: string; confidence: number }> };
      const hits = (data.results ?? []).slice(0, 3);
      if (hits.length > 0) {
        const block = [
          "## PLAYBOOK (from previous verified tasks)",
          ...hits.map((h) => `- [${h.pattern}] ${h.content}`),
          "",
          "These are evidence-backed observations from verified runs. Apply them when relevant; ignore them when a task clearly calls for something different.",
        ].join("\n");
        apiMessages.push({ role: "user", content: block });
        fullDisplayContent += `\n*[Playbook learnings applied]*\n`;
        setDisplayContent(fullDisplayContent);
      }
    } catch {}
  }

  // === Loop detection state ===
  const readFiles = new Map<string, number>(); // path → count of times read
  const readResults = new Map<string, string>(); // path → content preview
  // Durable workspace memory: full content of every successfully read file.
  // Re-injected into the latest message each turn (buildWorkspaceDigest) so
  // the model keeps file contents even after budget trimming drops older
  // messages — otherwise it re-reads files forever ("reads but never builds").
  const contextFiles = new Map<string, string>();
  let retriedAfterDup = false;
  /** Compact digest of all files read this task, injected into the last msg. */
  function buildWorkspaceDigest(): string {
    if (contextFiles.size === 0) return "";
    let out = "[WORKSPACE FILES — already read; do NOT re-read, use these contents]\n";
    let budget = 6000; // chars (~1500 tokens)
    for (const [p, c] of contextFiles) {
      const body = c.length > 2500 ? c.slice(0, 2500) + "\n…[truncated]" : c;
      const block = `--- ${p} ---\n${body}\n`;
      if (block.length > budget) break;
      out += block;
      budget -= block.length;
    }
    return out;
  }
  const toolCounts = new Map<string, number>(); // tool name → count of times called
  const loopStreaks = createLoopStreaks(); // consecutive-repeat state (loop-detect.ts)
  // Loop breaker: one automatic strategy-change attempt per task, then an
  // honest stop. lastToolResults is the evidence the directive quotes.
  let loopBreakAttempted = false;
  let lastToolResults = "";
  let turnsWithTools = 0;
  let hasShownText = false;
  let totalWrites = 0;
  // Browser-screenshot pixels awaiting vision: collected from dispatch
  // outcomes, forwarded once on the NEXT model turn (the chat route's vision
  // preprocessor describes them for text-only models), then dropped — stale
  // pixels must never ride every turn. Capped: TPM is the free-tier budget.
  let pendingShotImages: string[] = [];
  const MAX_SHOTS_PER_TURN = 2;
  // Scratchpad: the model's private working memory (plan drafts, hypotheses,
  // intermediate results, next move). Complex tasks start seeded so weak
  // models write into structure; simple tasks start empty (zero tokens until
  // the model actually uses it).
  let scratch: ScratchpadState = sparcDirective
    ? seedScratchpad(typeof userMessage === "string" ? userMessage : "")
    : createScratchpad();
  let scratchNudged = false;
  const pushScratchpadToUI = () => {
    try {
      setScratchpadText(renderScratchpadBlock(scratch));
    } catch {}
  };
  pushScratchpadToUI();
  // Each "continue" at a safety cap resets counters — bound how many times
  // the user (or a stuck UI) can keep granting it.
  let safetyContinueGrants = 0;
  const MAX_SAFETY_CONTINUES = 5;
  // Files written/edited this task (path → final content) — feeds the
  // self-review pass after the tool loop.
  const writtenFiles = new Map<string, string>();
  // Reliability gate (Phase 1, RELIABILITY_GATES=1): the pre-task baseline is
  // captured lazily on the FIRST mutating tool call, so a read-only task never
  // pays for a tsc run. Without a baseline the gate cannot tell a regression
  // from a pre-existing failure, so capturing it is mandatory under the flag.
  let gateBaseline: WorkspaceBaseline | null = null;
  let gateBaselineCaptured = false;
  // True when the gate pipeline is STILL red after every repair round. A task
  // that ends in this state is a failure wearing a success — the files are
  // written but the workspace does not compile — so it must close as [FAILED]
  // (Retry offered, ledger records FAIL), exactly like an empty response does.
  let gateRed = false;
  // One collapsible [THINKING] block per turn — rebuilt in place as
  // reasoning streams in, then closed once the turn's answer text folds in.
  let thinkingDisplay = "";
  const THINK_OPEN = "\n[THINKING]\n";
  const THINK_CLOSE = "\n[/THINKING]\n";
  // === Bounded per-chunk display repair (UI-freeze fix) =====================
  // The gpt-oss replay repair is a heavy regex sweep: running it over the
  // WHOLE transcript on EVERY streamed chunk is O(n²) and — combined with the
  // per-chunk subscriber fan-out — saturated the main thread, so every button
  // (Stop included) froze until the agent finished. The corruption is
  // phrase-level and ADJACENT, so repairing a bounded tail of the streamed
  // text is behaviorally identical for LIVE display; final assembly still
  // runs the full repair + dedupe over everything before the task persists.
  let streamedText = "";      // full streamed answer text so far (this turn)
  let repairedTail = "";      // cleaned tail being incrementally extended
  let sealedClean = "";       // cleaned prefix already beyond the repair window
  const STREAM_REPAIR_TAIL = 600;
  // Rebuild the collapsible [THINKING] block ONLY when thinkingDisplay
  // actually changed — never per content chunk. Live view shows the RAW
  // reasoning: the heavy replay repair is O(n²) across a long think and ran
  // per delta, which (with per-chunk fan-out) froze the UI. The fold sites
  // and final assembly still run the full repair before anything persists.
  let lastThinkingSeen: string | null = null;
  let thinkingBlockCache = "";
  const thinkingBlock = () => {
    if (thinkingDisplay === lastThinkingSeen) return thinkingBlockCache;
    lastThinkingSeen = thinkingDisplay;
    thinkingBlockCache = thinkingDisplay ? THINK_OPEN + thinkingDisplay + THINK_CLOSE : "";
    return thinkingBlockCache;
  };
  /**
   * composeDisplay(text) — text is the FULL streamed answer so far. Only the
   * newly added tail is repaired; everything earlier was already cleaned on
   * a previous chunk and is spliced back verbatim. Per-chunk cost stays
   * proportional to the chunk, not the transcript length.
   */
  const composeDisplay = (text: string) => {
    // composeDisplay("") is how a thinking delta refreshes the display, so an
    // EMPTY text must mean "no new content" rather than "the stream is empty".
    // The old guard `text.length >= streamedText.length && startsWith` is false
    // for "" once anything has streamed, so every reasoning block after content
    // fell into the else branch and reset sealedClean + repairedTail - the
    // partially-streamed answer visibly VANISHED for the whole thinking block
    // and only reappeared on the next content delta. It also permanently
    // clobbered streamedText's role as a monotonic growth cursor.
    if (text === "") {
      // Refresh only the thinking block; leave the answer text intact.
      const excess = repairedTail.length - STREAM_REPAIR_TAIL;
      if (excess > 0) {
        sealedClean += repairedTail.slice(0, excess);
        repairedTail = repairedTail.slice(excess);
      }
      return fullDisplayContent + thinkingBlock() + sealedClean + repairedTail;
    }
    if (text.length >= streamedText.length && text.startsWith(streamedText)) {
      // Continuation of this turn's stream — clean only the new tail.
      repairedTail = dedupeStreamedChunk(repairedTail, text.slice(streamedText.length));
    } else {
      // New turn (or shrunk) — restart the bounded repair from scratch.
      sealedClean = "";
      repairedTail = deduplicateWords(text);
    }
    streamedText = text;
    const excess = repairedTail.length - STREAM_REPAIR_TAIL;
    if (excess > 0) {
      sealedClean += repairedTail.slice(0, excess);
      repairedTail = repairedTail.slice(excess);
    }
    return fullDisplayContent + thinkingBlock() + sealedClean + repairedTail;
  };

  // === Execute orchestrator-planned writes (SPARC / ToT winners) =========
  // Runs through the audited write path (file history, plugins, counters).
  //
  // PLAN MODE MUST GATE THIS, exactly like the model's own tool calls do.
  // The server-side strategy router is triggered for plan mode too
  // (sparcDirective is set for any `mode !== "ask"`), and its returned
  // write_file calls used to be written straight to disk here - no plan latch,
  // no approval request. That defeated the hard plan gate completely: a
  // complex task started in plan mode mutated the workspace before the user had
  // approved anything. Worse, executeOrchestratedWrites seeds `writtenFiles`,
  // which is the precondition for the self-review, typecheck-repair and swarm
  // lanes below - so one ungated batch unlocked a chain of further ungated
  // writes.
  const orchestrateBlockedByPlan =
    mode === "plan" && planGateBlocks(taskId, "write_file");
  if (orchestrateBlockedByPlan) {
    // Readable, non-fatal: the plan itself is still shown, and the withheld
    // file list tells the agent what it still has to ask for.
    const withheld = orchestratedToolCalls
      .filter((c) => c.name === "write_file" && typeof c.path === "string")
      .map((c) => `\`${c.path}\``)
      .join(", ");
    fullDisplayContent += `\n${orchestrationSummary}\n\n[GATE] Plan not approved — withheld ${orchestratedToolCalls.length} orchestrator write(s)${withheld ? `: ${withheld}` : ""}. Present your plan and wait for approval.\n`;
    setDisplayContent(fullDisplayContent);
    emitActivity({ type: "thinking", message: "Orchestrator writes blocked — awaiting plan approval" });
    // Same latch semantics as the main loop: first block asks, and the answer
    // opens (or permanently closes) the gate for the rest of the task.
    if (!isPlanRejected(taskId)) {
      void requestApproval(
        "write_file",
        "Plan approval needed before the orchestrator writes files",
        { planGate: true, taskId, blockedTool: "write_file", tool: "write_file", summary: "Approve the plan to let the agent write files." },
        undefined,
        "medium"
      ).then((approved) => {
        if (approved) approvePlan(taskId);
        else rejectPlan(taskId);
      }).catch(() => {});
    }
  }
  if (orchestratedToolCalls.length > 0 && !orchestrateBlockedByPlan) {
    fullDisplayContent += `\n${orchestrationSummary}\n`;
    setDisplayContent(fullDisplayContent);
    const written = await executeOrchestratedWrites(orchestratedToolCalls, {
      get totalWrites() { return totalWrites; },
      set totalWrites(v: number) { totalWrites = v; },
      writtenFiles,
      bumpStat,
      setFilesChanged,
      label: orchestrationLabel,
      abortSignal,
      isStale: () => myGeneration !== getGeneration(),
    });
    orchestratedWrites = written;
    if (written > 0) {
      fullDisplayContent += `\n**${orchestrationLabel} wrote ${written} file(s).** Continuing with refinement and review…\n`;
      setDisplayContent(fullDisplayContent);
      // Seed the loop so the model reviews/refines what was just written
      apiMessages.push({
        role: "user",
        content: `${orchestrationSummary}\nThe planning phase already wrote the files listed above via the orchestrator. READ each file you wrote, review it critically, fix problems with edit_file, and finish anything incomplete. Then summarize.`,
      });
    }
  }

  try {
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      // Exit quietly if Stop was pressed (or a newer task superseded us)
      if (abortSignal?.aborted || !isCurrentTask(taskId)) {
        return;
      }

      updateTaskStatus("streaming", turn === 0 ? "Thinking…" : "Processing…");

      // Emit structured status for frontend progress display
      emitStatus({
        type: "step",
        agent: turn === 0 ? "coordinator" : "coder",
        label: turn === 0 ? "Analyzing request…" : `Processing turn ${turn + 1}…`,
        status: "active",
      });

      // Screenshots captured on previous turns ride along once so the model
      // SEES what it captured (vision preprocessor describes them for
      // text-only models). User attachments go every turn, as before.
      const turnImages = pendingShotImages.length > 0
        ? [...imageDataUrls, ...pendingShotImages.slice(-MAX_SHOTS_PER_TURN)]
        : imageDataUrls;
      pendingShotImages = [];

  // Set when the provider's stream actually terminated ([DONE]). A connection
  // dropped mid-answer looks identical to a clean finish from the caller's
  // side, and the truncated text used to be saved to the DB as a successful
  // exchange.
  let streamEndedCleanly = false;
  const streamResult = await callModel(
    apiMessages,
    runState,
        conversationId,
        {
          onChunk: (content) => {
            // Bounded repair + single rebuilt thinking block per turn — see
            // composeDisplay above. Re-repairing the whole transcript per
            // chunk used to freeze the UI mid-run.
            setDisplayContent(composeDisplay(content));
          },
    onThinking: (thinking) => {
      // Display M3 thinking in real-time inside the collapsible block
      thinkingDisplay += thinking;
      setDisplayContent(composeDisplay(""));
      // Emit thinking activity
      emitActivity({ type: "thinking", message: thinking.slice(-80) });
    },
    onDone: () => {
      streamEndedCleanly = true;
    },
  },
        mode,
        turnImages,
        abortSignal,
        effort,
        // Compact profile from turn 2 onward: the full master prompt is
        // already in the conversation's history — resending the whole
        // doctrine every turn burns free-tier TPM for no behavioral gain.
        turn === 0 ? "full" : "compact",
        { taskId, turn, why: turn === 0 ? "initial" : `tool-loop turn ${turn + 1}` },
        selectedModel
      );

  // Abort mid-stream (Stop pressed) — discard this turn, unwind to the
  // catch below which exits quietly instead of failing the task.
  if (abortSignal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  // The stream ended without a [DONE] marker: the connection dropped partway
  // through the answer. Mark it so the text is not persisted and displayed as
  // if it were the complete reply.
  if (!streamEndedCleanly) {
    const cut = normalizeThinkingBlocks(streamResult?.content ?? "");
    if (cut.trim()) {
      fullDisplayContent += `${cut}\n\n[INCOMPLETE — the connection dropped before this reply finished. The text above is a partial answer.]`;
    }
    setDisplayContent(fullDisplayContent);
  }

      const streamedContent = streamResult.content;
      if (!streamedContent && streamResult.toolCalls.length === 0) {
        // Empty response — set minimal content so message isn't stuck on "Thinking..."
        // and stamp [FAILED] so the renderer offers one-click Retry.
        if (!fullDisplayContent.trim()) {
          fullDisplayContent = "*No response from the model. Try again.*";
        }
        failedEmptyResponse = true;
        break;
      }
      lastStreamedContent = streamedContent || "";

      // Use native tool calls from stream, fall back to XML parsing
      const rawToolCalls = streamResult.toolCalls.length > 0
        ? streamResult.toolCalls
        : parseToolCalls(streamedContent || "");
      // Detect truncated tool calls (missing required args due to token limit)
      const truncatedCalls = rawToolCalls.filter(tc => {
        if (tc.name === 'write_file' && (!tc.path || tc.content === undefined)) return true;
        if (tc.name === 'edit_file' && (!tc.path || !tc.old_text || !tc.new_text)) return true;
        if (tc.name === 'read_file' && !tc.path) return true;
        return false;
      });
      const toolCalls = rawToolCalls.filter(tc => !truncatedCalls.includes(tc));
      const textOnly = (streamedContent || "").replace(/[<]tool_call[\s\S]*?[<]\/tool_call[>]/g, "").trim();

      // Fold the turn's reasoning block into the transcript (closed) before
      // any of the turn's content below is appended, so the collapsible
      // ThinkingCard renders the full reasoning followed by the answer.
      if (thinkingDisplay) {
        fullDisplayContent += thinkingBlock();
        thinkingDisplay = "";
      }

      // === TRUNCATION DETECTION: Auto-continue if tool calls were truncated ===
      if (truncatedCalls.length > 0 && toolCalls.length === 0) {
        // All tool calls were truncated — send a continue message
        const truncatedPaths = truncatedCalls.map(tc => tc.path || 'unknown').join(', ');
        fullDisplayContent += `[Truncated: ${truncatedPaths} — continuing...]\n`;
        setDisplayContent(fullDisplayContent);
        apiMessages.push({ role: "assistant", content: streamedContent || "" });
        apiMessages.push({ role: "user", content: truncationContinue(truncatedCalls[0]?.path) });
        continue; // Skip to next turn instead of breaking
      }

      // === STOP: No valid tool calls => final answer ===
      if (toolCalls.length === 0) {
        // AUTO-RETRY: If user asked to build/create/make something AND nothing
        // was written yet, force tool usage. LIVE-VALIDATED false positive:
        // this used to fire on the model's *final summary* after successful
        // writes — "You described the plan but created no files" — even when
        // write_file had succeeded. The written-files check makes the nudge
        // impossible once real work exists.
        const buildKeywords = /build|create|make|generate|write|code|develop|implement|set up|set up/i;
        const userWantsFiles = userMessage && buildKeywords.test(userMessage);
        const hasTextResponse = textOnly.length > 20;
        // orchestratedWrites is the ACTUAL executed count — a planned batch
        // that fully failed must not suppress the FORCE-TOOLS nudge.
        const hasWrittenFiles = writtenFiles.size > 0 || totalWrites > 0 || orchestratedWrites > 0;
        const alreadyRetried = apiMessages.some(m => m.role === "user" && m.content?.includes("[FORCE TOOLS]"));

        if (userWantsFiles && hasTextResponse && !hasWrittenFiles && !alreadyRetried) {
          // M3 described what it would do but didn't use tools — force it
          fullDisplayContent += textOnly + "\n\n";
          apiMessages.push({ role: "assistant", content: streamedContent || "" });
          apiMessages.push({ role: "user", content: FORCE_TOOLS_DIRECTIVE });
          continue; // Retry with forced tool usage
        }

        // BROWSER-TASK NUDGE: the user asked for live browsing but the model
        // never touched its browser (often it writes a Selenium script with
        // write_file instead of driving its own browser — that counts as tool
        // use, so the check must be browser-specific, not turnsWithTools).
        // Same one-retry pattern as FORCE TOOLS — without this, weak models
        // leave users thinking the feature is broken and they abandon the
        // app. Skipped in ask mode (tools off by design).
        const browserKeywords = /https?:\/\/|www\.|localhost|\.com|\.org|\.io|\.dev|\bbrows|\bnavigat|open (the|this|that|a)? ?(page|site|website|url|browser)|google|website|webpage|screenshot|visit|go to|check (the|this|that) site/i;
        const userWantsBrowsing = mode !== "ask" && userMessage && browserKeywords.test(userMessage);
        const usedBrowserTools = Array.from(toolCounts.keys()).some(k => k.startsWith("browser_"));
        const alreadyRetriedBrowser = apiMessages.some(m => m.role === "user" && m.content?.includes("[FORCE BROWSER TOOLS]"));

        if (userWantsBrowsing && hasTextResponse && !usedBrowserTools && !alreadyRetriedBrowser) {
          // Model dodged the browser tools — force them, once
          fullDisplayContent += textOnly + "\n\n";
          apiMessages.push({ role: "assistant", content: streamedContent || "" });
          apiMessages.push({ role: "user", content: FORCE_BROWSER_TOOLS_DIRECTIVE });
          continue; // Retry with forced browser tool usage
        }

        fullDisplayContent += streamedContent || "";
        break;
      }

      // M3 outputs text AND tool calls together — execute the tools, show the text
      // (Previously this broke the loop — tools were never executed)

      // === STOP: Smart loop detection ===
      turnsWithTools++;

      // Track tool usage for deduplication + feature gates
      for (const call of toolCalls) {
        toolCounts.set(call.name, (toolCounts.get(call.name) || 0) + 1);
        if (call.name === "write_file" || call.name === "edit_file") totalWrites++;
      }

      // Streak-based loop detection, O(1) per turn — runs BEFORE dispatch, so
      // a trip never executes the offending call (the duplicate the model
      // just re-sent costs zero tool time). See loop-detect.ts: identical
      // call 3x in a row, same target 4x with noisy args, the same multi-call
      // turn 3x, or one state-changing tool every turn for 5 turns.
      const loopVerdict = trackToolTurn(loopStreaks, toolCalls);

      // === LOOP TRIP: self-heal once, then stop honestly ==================
      // The old flow asked the user "keep going?" for loops; clicking
      // Continue reset the counters but not the model's behavior, so the same
      // call came back (the observed "stuck in a loop" failure). Now the
      // first trip injects the repeated call + its last result and demands a
      // different action — no user nag; a second trip (evidence ignored)
      // stops the task with an honest note instead of burning the TPM window.
      if (loopVerdict.loop) {
        const loopReason = loopVerdict.reason!;
        fullDisplayContent += textOnly ? textOnly + "\n" : "";
        if (loopBreakAttempted) {
          fullDisplayContent += `\n*[Stopped — the agent kept repeating ${loopReason} even after a strategy-change instruction. No further calls were run.]*\n`;
          setDisplayContent(fullDisplayContent);
          break;
        }
        loopBreakAttempted = true;
        fullDisplayContent += `\n*[Loop detected — ${loopReason}. Forcing a strategy change.]*\n`;
        setDisplayContent(fullDisplayContent);
        apiMessages.push({ role: "assistant", content: streamedContent || "" });
        apiMessages.push({ role: "user", content: buildLoopBreakDirective(loopVerdict, lastToolResults) });
        Object.assign(loopStreaks, createLoopStreaks());
        continue;
      }

      if (turnsWithTools >= MAX_TOOL_TURNS - 2 || totalWrites >= MAX_TOTAL_WRITES) {
        const reason = totalWrites >= MAX_TOTAL_WRITES
          ? `Too many file writes (${totalWrites})`
          : `Reached ${turnsWithTools} tool turns`;
        // Interactive autonomy: at a safety cap, ASK instead of dying. The
        // user can continue (counters reset) or stop here — up to
        // MAX_SAFETY_CONTINUES times, so a stuck UI can't loop forever.
        if (!abortSignal?.aborted && mode !== "ask" && isCurrentTask(taskId) && safetyContinueGrants < MAX_SAFETY_CONTINUES) {
          setQuestion(
            `Hit a safety limit — ${reason}. Keep going?`,
            ["Continue working", "Stop here"],
            true
          );
          updateTaskStatus("awaiting_approval", `Safety limit: ${reason}`);
          fullDisplayContent += (textOnly ? textOnly + "\n" : "") + `\n*[Safety limit — ${reason}]*\n`;
          setDisplayContent(fullDisplayContent);
          const answer = await waitForAnswer(120_000);
          if (/continue|keep|yes/i.test(answer)) {
            safetyContinueGrants++;
            toolCounts.clear();
            Object.assign(loopStreaks, createLoopStreaks());
            totalWrites = 0;
            turnsWithTools = 0;
            fullDisplayContent += `\n*[Continuing — limit reset by user (${MAX_SAFETY_CONTINUES - safetyContinueGrants} extensions left)]*\n`;
            setDisplayContent(fullDisplayContent);
            apiMessages.push({ role: "assistant", content: streamedContent || "" });
            apiMessages.push({
              role: "user",
              content: `${SAFETY_CONTINUE_DIRECTIVE} (limit: ${reason})`,
            });
            continue;
          }
        }
        fullDisplayContent += textOnly || `\n*[Stopped — ${reason}]*\n`;
        break;
      }

      if (textOnly) fullDisplayContent += textOnly + "\n\n";

      // === Execute tools with deduplication (dispatcher: agent/native-tools.ts) ===
      let toolResults = "";
      let skippedDueToDup = false;

      const toolCtx: ToolContext = {
        mode,
        readFiles,
        contextFiles,
        readResults,
        abortSignal: abortSignal ?? null,
        fs: {
          readFile: _readFile,
          writeFile: _writeFile,
          editFile: _editFile,
          // Client lane pages from the (budgeted) cached full text — the
          // dispatcher slices it by line; server lanes stream from disk.
          readPage: async (p: string, offsetLine: number, limitLines: number) => {
            if (!_readFile) return null;
            try {
              const full = await _readFile(p);
              if (full.startsWith("[Error") || full === "(file not available)") return null;
              const lines = full.endsWith("\n") ? full.slice(0, -1).split("\n") : full.split("\n");
              const start = Math.max(1, offsetLine);
              const slice = lines.slice(start - 1, start - 1 + limitLines);
              return {
                text: slice.join("\n"),
                startLine: start,
                endLine: start - 1 + slice.length,
                totalLines: lines.length,
                hasMore: start - 1 + slice.length < lines.length,
              };
            } catch { return null; }
          },
          directoryName: _directoryName,
        },
        counters: {
          writtenFiles,
          getTotalWrites: () => totalWrites,
          setTotalWrites: (n) => { totalWrites = n; },
          setFilesChanged,
          bumpStat: (key) => bumpStat(key),
        },
        fileTree: _fileTree,
        fileContents: _fileContents,
        store: {
          setTodos: (items) => setTodos(items),
          completeTodo: (i) => completeTodo(i),
          clearTodos: () => clearTodos(),
          setQuestion: (q, opts, free, meta) => setQuestion(q, opts, free, meta),
          answerQuestion: (a) => answerQuestion(a),
        },
        stats: {
          commandRun: () => bumpStat("commandsRun"),
          failedStep: () => bumpStat("failedSteps"),
          rejectedAction: () => bumpStat("rejectedActions"),
        },
        hooks: {
          fileWritten: (p, c) => onFileWrite(p, c).catch(() => {}),
          fileEdited: (p, o, n) => onFileEdit(p, o, n).catch(() => {}),
        },
        getDisplay: () => fullDisplayContent,
        appendDisplay: (text) => { fullDisplayContent += text; },
        scratchpad: {
          get: () => scratch,
          update: (section: ScratchpadSection, content: string) => {
            scratch = updateScratchpadSection(scratch, section, content, turn);
            pushScratchpadToUI();
          },
        },
        setStatus: (status, detail) => updateTaskStatus(status, detail),
        replaceStatus: (line) => { fullDisplayContent = replaceLastStatus(fullDisplayContent, line); },
        syncDisplay: () => setDisplayContent(fullDisplayContent),
        waitForAnswer,
      };

      for (const call of toolCalls) {
        // Stop pressed (or task superseded) while tools were being dispatched —
        // bail out of the whole turn instead of running more tools.
        if (abortSignal?.aborted || !isCurrentTask(taskId)) {
          throw new DOMException("Aborted", "AbortError");
        }

        // === PLUGIN HOOK: beforeToolCall ===
        const pluginArgs = await beforeToolCall(call.name, call as any).catch(() => call as any);
        if (!pluginArgs || pluginArgs._blocked) {
          toolResults += `<tool_result name="${call.name}">BLOCKED by plugin</tool_result>\n`;
          continue;
        }

        // === SPARC PLAN-FIRST GATE (Tree of Thought, enforced) ===
        // On complex tasks, writes/edits are blocked until the model has
        // planned (todo_list) and looked at the workspace (read/list/search).
        if (
          sparcDirective &&
          (call.name === "write_file" || call.name === "edit_file" || call.name === "write_file_chunk" || call.name === "batch_edit") &&
          !(toolCounts.get("todo_list") || readFiles.size || readResults.size)
        ) {
          toolResults += `<tool_result name="${call.name}">BLOCKED by plan-first gate: create a todo_list plan (and read/list the relevant files) before writing code. Call todo_list first, then retry ${call.name}.</tool_result>\n`;
          fullDisplayContent += `[GATE] ${call.name} blocked — plan first\n`;
          setDisplayContent(fullDisplayContent);
          continue;
        }

        // === HARD PLAN-APPROVAL GATE (Claude Code parity) ===
        // In plan mode NOTHING state-changing runs until the user explicitly
        // approves the plan. Blocking is a readable tool result so the agent
        // adapts; the latch opens only via the approval decision.
        if (mode === "plan" && planGateBlocks(taskId, String(call.name))) {
          const msg = planGateMessage(String(call.name));
          toolResults += `<tool_result name="${call.name}">${msg}</tool_result>\n`;
          fullDisplayContent += `[GATE] ${call.name} blocked — plan not approved\n`;
          setDisplayContent(fullDisplayContent);
          // First block surfaces the approval request to the user.
          // NOTE: the approval TYPE must match the blocked tool — filing
          // everything as "run_command" mislabels the dialog, mis-scores
          // risk, and keys "always allow" rules on the wrong fields.
          if (!isPlanRejected(taskId)) {
            const toolName = String(call.name);
            const gateType: ApprovalType =
              toolName === "write_file" || toolName === "write_file_chunk"
                ? "write_file"
                : toolName === "edit_file" || toolName === "batch_edit"
                  ? "edit_file"
                  : toolName.startsWith("mcp__")
                    ? "mcp_tool"
                    : "run_command";
            void requestApproval(
              gateType,
              `Plan approval needed before ${call.name}`,
              { planGate: true, taskId, blockedTool: call.name, path: call.path, command: call.command, tool: call.name, summary: "Approve the plan to let the agent write files." },
              undefined,
              "medium"
            ).then((approved) => {
              if (approved) approvePlan(taskId);
              else rejectPlan(taskId);
            }).catch(() => {});
          }
          continue;
        }

        // === EDIT LOCK (reliability, Phase 1) ===
        // A red gate must refuse further mutations, not just display them. The
        // lock is checked here, at the single dispatch point every write path
        // funnels through, so a repair turn that keeps writing onto a red gate
        // gets an explicit refusal it can adapt to instead of silently deepening
        // the failure. run_command is deliberately NOT locked: it is the lane the
        // repair loop uses to clear the gate, and locking it would wedge the task.
        if (
          reliabilityEditLockEnabled() &&
          (call.name === "write_file" || call.name === "write_file_chunk" || call.name === "edit_file" || call.name === "batch_edit")
        ) {
          const lock = isEditLocked(taskId);
          if (lock) {
            recordRefusedWrite(taskId);
            const redList = [...lock.redLanes].join(", ");
            toolResults += `<tool_result name="${call.name}">BLOCKED by edit lock: the ${redList} gate is failing. Fix the reported errors first (they are in the last verification block), then retry ${call.name}. Writing while the gate is red only adds more errors.</tool_result>\n`;
            fullDisplayContent += `[GATE] ${call.name} blocked — edit lock (${redList})\n`;
            setDisplayContent(fullDisplayContent);
            continue;
          }
        }

        // Lazily capture the pre-task baseline on the FIRST mutating call, so a
        // read-only task never pays for a tsc run. This MUST happen before the
        // write, not after: the baseline is the "before" snapshot the gate diffs
        // against to decide whether a failure is this task's fault.
        if (
          reliabilityBaselineEnabled() &&
          !gateBaselineCaptured &&
          (call.name === "write_file" || call.name === "write_file_chunk" || call.name === "edit_file" || call.name === "batch_edit")
        ) {
          gateBaselineCaptured = true;
          updateTaskStatus("tool_executing", "Capturing pre-task verification baseline…");
          gateBaseline = await captureBaseline(
            (cmd, timeoutMs) =>
              apiFetch("/api/agent/exec", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ command: cmd, timeout: timeoutMs }),
                signal: abortSignal ?? undefined,
              }).then(async (r) => {
                const d = await r.json();
                return { exitCode: d?.exitCode as number | undefined, stdout: d?.stdout as string, stderr: d?.stderr as string };
              }),
            abortSignal ?? undefined,
          );
        }

        // A throwing tool must not take down the turn. Several tools are only
        // partially guarded internally (read_file's whole-file read,
        // list_files, the write/edit approval paths, ask_question), and an
        // unhandled rejection used to propagate out of this loop: the
        // remaining tool calls in the turn never ran, the model never received
        // their <tool_result>, and the whole task died with a raw error.
        // Aborts still propagate — they are control flow, not tool failures.
        let outcome: Awaited<ReturnType<typeof dispatchToolCall>>;
        try {
          outcome = await dispatchToolCall(call, toolCtx);
        } catch (err) {
          if (abortSignal?.aborted || (err as { name?: string })?.name === "AbortError") throw err;
          const msg = err instanceof Error ? err.message : String(err);
          toolResults += `<tool_result name="${call.name}">\nerror: ${msg}\n</tool_result>\n`;
          try {
            toolCtx.replaceStatus(`[FAIL] ${call.name} — ${msg.slice(0, 120)}`);
            toolCtx.syncDisplay();
          } catch {}
          continue;
        }
        toolResults += outcome.resultXml;
        if (outcome.dedupRead) skippedDueToDup = true;
        // Screenshot pixels → vision channel on the next turn (capped).
        if (outcome.imageDataUrl) {
          pendingShotImages.push(outcome.imageDataUrl);
          if (pendingShotImages.length > MAX_SHOTS_PER_TURN) {
            pendingShotImages.splice(0, pendingShotImages.length - MAX_SHOTS_PER_TURN);
          }
        }

        // === PLUGIN HOOK: afterToolCall ===
        afterToolCall(call.name, call as any, outcome.resultXml.slice(-200)).catch(() => {});
      }


      // === LOOP DETECTION: If all reads were duplicates, stop ===
      if (skippedDueToDup && toolCalls.every(c => c.name !== "write_file")) {
        if (!retriedAfterDup && contextFiles.size > 0) {
          // Second chance: instead of dying, re-present the workspace digest
          // and order it to BUILD with what it has.
          retriedAfterDup = true;
          fullDisplayContent += "\n**[Workspace already in context — building from it now…]**\n";
          setDisplayContent(fullDisplayContent);
          apiMessages = [
            ...apiMessages,
            { role: "assistant", content: streamedContent || "" },
            { role: "user", content: `${buildWorkspaceDigest()}\n[TOOL RESULTS]\n${toolResults}\nSTOP re-reading. You have the complete file contents above. Now PRODUCE THE RESULT: write the files with write_file / edit_file, or give the final answer. Re-reading anything is prohibited.` },
          ];
          continue;
        }
        fullDisplayContent += "\n\n*[Stopping — agent was re-reading files it already has. Use the information above to answer.]*\n";
        break;
      }

      fullDisplayContent += "\n";
      // Evidence for the loop breaker on the NEXT turn (the breaker quotes
      // the most recent tool output — a loop usually re-sends right after it).
      lastToolResults = toolResults;

      // Scratchpad rides the LAST message (same trim-proof pattern as the
      // task anchor): re-rendered fresh every turn from live state, so it is
      // always current and can never be evicted by budget trimming.
      const scratchBlock = renderScratchpadBlock(scratch);
      // One nudge max: complex task, several turns in, scratchpad untouched.
      let scratchNudge = "";
      if (sparcDirective && turn >= 2 && isScratchpadEmpty(scratch) && !scratchNudged) {
        scratchNudged = true;
        scratchNudge = `\n[SCRATCHPAD] Use scratchpad_update to record your plan, key findings, and next move before continuing.`;
      }
      // "You now have all the information you need" was asserted on EVERY
      // tool turn, including turns whose result was "No files found at that
      // path." That is an affirmative instruction to proceed on absent data,
      // which is how an empty workspace produced confident speculation. Only
      // claim sufficiency when the results actually contain something, and
      // tell the model plainly when they do not.
      const resultsAreEmpty =
        !contextFiles.size &&
        /No files found at that path\.|no results|not found|No results found/i.test(
          toolResults,
        );
      const sufficiencyDirective = resultsAreEmpty
        ? "The tool returned NOTHING for this call. Do not call it again with the same or a similar argument — repeating it cannot succeed. Either try a materially different action, or tell the user plainly what you could not find and stop."
        : "You now have all the information you need. Act on it: write files or answer. Do NOT re-read files you've already read.";

      apiMessages = [
        ...apiMessages,
        { role: "assistant", content: streamedContent || "" },
        { role: "user", content: `[TOOL RESULTS]\n${toolResults}${contextFiles.size ? `\n${buildWorkspaceDigest()}` : ""}${scratchBlock ? `\n${scratchBlock}` : ""}${scratchNudge}\n${sufficiencyDirective}` },
      ];
    }

    // === SELF-REVIEW: static quality check on files written this task ===
    // One self-repair turn if critical issues are found (wires up the
    // previously dead quickQualityCheck + QUALITY CHECKLIST prompt).
    // Runs AFTER the tool loop so the final turn's writes are included.
    if ((mode === "code" || mode === "plan") && writtenFiles.size > 0 && !abortSignal?.aborted && isCurrentTask(taskId)) {
      const qc = quickQualityCheck([...writtenFiles.entries()].map(([path, content]) => ({ path, content })));
      if (qc.criticalCount > 0) {
        updateTaskStatus("tool_executing", "Self-reviewing generated code…");
        const issueLines = [...writtenFiles.entries()]
          .flatMap(([path, content]) =>
            analyzeCodeQuality(path, content)
              .issues.filter((i: { severity: string }) => i.severity === "error")
              .map((i: { category: string; message: string; line?: number; fix?: string }) => `- \`${path}\` [${i.category}] ${i.message}${i.line ? ` (line ${i.line})` : ""}${i.fix ? ` → ${i.fix}` : ""}`)
          )
          .slice(0, 10)
          .join("\n");
        fullDisplayContent += `\n**Self-review:** ${qc.summary} — ${qc.criticalCount} critical issue(s), applying fixes…\n`;
        setDisplayContent(fullDisplayContent);
        emitActivity({ type: "thinking", message: `Self-review: ${qc.criticalCount} critical issue(s) found` });

        if (lastStreamedContent) apiMessages.push({ role: "assistant", content: lastStreamedContent });
        apiMessages.push({
          role: "user",
          content: qualityReviewDirective(issueLines),
        });

        const reviewStream = await callModel(apiMessages, runState, conversationId, {
          onChunk: (c) => setDisplayContent(composeDisplay(c)),
          onThinking: (t) => {
            thinkingDisplay += t;
            setDisplayContent(composeDisplay(""));
          },
        }, mode, imageDataUrls, abortSignal, effort, "compact", { taskId, turn: -1, why: "quality-review" });

        if (abortSignal?.aborted) throw new DOMException("Aborted", "AbortError");

        if (thinkingDisplay) {
          fullDisplayContent += repairInterleavedReplay(THINK_OPEN + thinkingDisplay + THINK_CLOSE);
          thinkingDisplay = "";
        }
        if (reviewStream.content) fullDisplayContent += reviewStream.content + "\n";

        for (const call of reviewStream.toolCalls) {
          if (abortSignal?.aborted || !isCurrentTask(taskId)) return;
          if (call.name === "write_file" && call.path && call.content !== undefined) {
            updateTaskStatus("tool_executing", `Fixing ${call.path}...`);
            let ok = false;
            if (_writeFile) {
              const prevContent = _readFile ? await _readFile(call.path).catch(() => null) : null;
              const hasPrev = prevContent && !prevContent.startsWith("[Error");
              recordChange(call.path, hasPrev ? prevContent : null, call.content);
              ok = await _writeFile(call.path, call.content);
            } else {
              ok = virtualFS.writeFile(call.path, call.content);
            }
            if (ok) {
              bumpStat("toolCalls");
              totalWrites++;
              setFilesChanged(totalWrites);
              writtenFiles.set(call.path, call.content);
            }
            fullDisplayContent = replaceLastStatus(fullDisplayContent, ok ? `[SUCCESS] Fixed \`${call.path}\`` : `[ERROR] Fix failed for \`${call.path}\``);
            setDisplayContent(fullDisplayContent);
          } else if (call.name === "edit_file" && call.path && call.old_text && call.new_text && _editFile) {
            updateTaskStatus("tool_executing", `Fixing ${call.path}...`);
            const ok = await _editFile(call.path, call.old_text, call.new_text);
            if (ok) {
              setFilesChanged(totalWrites + 1);
              if (_readFile) {
                const after = await _readFile(call.path).catch(() => null);
                if (after && !after.startsWith("[Error")) writtenFiles.set(call.path, after);
              }
            }
            fullDisplayContent = replaceLastStatus(fullDisplayContent, ok ? `[SUCCESS] Fixed \`${call.path}\`` : `[FAIL] Fix failed for \`${call.path}\``);
            setDisplayContent(fullDisplayContent);
          }
        }

        const qc2 = quickQualityCheck([...writtenFiles.entries()].map(([path, content]) => ({ path, content })));
        fullDisplayContent += qc2.criticalCount === 0
          ? `\n**Self-review passed** — score ${qc2.score}/100 ✓\n`
          : `\n**Self-review after fixes:** ${qc2.summary}\n`;
        setDisplayContent(fullDisplayContent);
        }

        // === MANDATORY SELF-REFLECTION (fires even when the analyzer found
        // nothing): one final model pass re-checking its own work against
        // the QUALITY CHECKLIST before the task reports done. ===
        updateTaskStatus("tool_executing", "Self-review re-check…");
        apiMessages.push({
          role: "user",
          content: SELF_REVIEW_DIRECTIVE,
        });
        const recheckStream = await callModel(apiMessages, runState, conversationId, {
          onChunk: (c) => setDisplayContent(composeDisplay(c)),
          onThinking: (t) => {
            thinkingDisplay += t;
            setDisplayContent(composeDisplay(""));
          },
        }, mode, imageDataUrls, abortSignal, effort, "compact", { taskId, turn: -1, why: "self-review-recheck" });
        if (abortSignal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (thinkingDisplay) {
          fullDisplayContent += repairInterleavedReplay(THINK_OPEN + thinkingDisplay + THINK_CLOSE);
          thinkingDisplay = "";
        }
        if (recheckStream.content) fullDisplayContent += recheckStream.content + "\n";

        // Execute any fixes the model makes during the re-check.
        for (const call of recheckStream.toolCalls) {
          if (abortSignal?.aborted || !isCurrentTask(taskId)) return;
          if (call.name === "write_file" && call.path && call.content !== undefined) {
            let ok = false;
            if (_writeFile) {
              const prevContent = _readFile ? await _readFile(call.path).catch(() => null) : null;
              const hasPrev = prevContent && !prevContent.startsWith("[Error");
              recordChange(call.path, hasPrev ? prevContent : null, call.content);
              ok = await _writeFile(call.path, call.content);
            } else {
              ok = virtualFS.writeFile(call.path, call.content);
            }
            if (ok) {
              bumpStat("toolCalls");
              totalWrites++;
              setFilesChanged(totalWrites);
              writtenFiles.set(call.path, call.content);
            }
            fullDisplayContent = replaceLastStatus(fullDisplayContent, ok ? `[SUCCESS] Fixed \`${call.path}\`` : `[ERROR] Fix failed for \`${call.path}\``);
          } else if (call.name === "edit_file" && call.path && call.old_text && call.new_text && _editFile) {
            const ok = await _editFile(call.path, call.old_text, call.new_text);
            if (ok) {
              const after = await _readFile?.(call.path).catch(() => null);
              if (after && !after.startsWith("[Error")) writtenFiles.set(call.path, after);
            }
            fullDisplayContent = replaceLastStatus(fullDisplayContent, ok ? `[SUCCESS] Fixed \`${call.path}\`` : `[FAIL] Fix failed for \`${call.path}\``);
          }
          setDisplayContent(fullDisplayContent);
        }
      }

    // === PARALLEL LANES: kick off the structured review probe now so it races
    // the typecheck verification instead of running after it. Wall-clock cost
    // of post-loop quality control becomes max(typecheck, review), not sum.
    // ONE reviewer call with a severity contract (was a 3-agent swarm);
    // findings are applied only AFTER verification completes, so no two
    // repair turns ever write concurrently.
    const reviewGateOk =
      autoVerify &&
      (mode === "code" || mode === "plan") &&
      writtenFiles.size > 0 &&
      !abortSignal?.aborted &&
      isCurrentTask(taskId);
    const reviewProbePromise: Promise<any> = reviewGateOk
      ? runOrchestration("review", {
          task: `Review these files written for: ${userMessage.slice(0, 500)}`,
          files: [...writtenFiles.entries()].slice(0, 8).map(([path, content]) => ({ path, content })),
        })
      : Promise.resolve(null);

    // === AUTO-VERIFICATION: close the loop (write → typecheck → repair) =====
    // Code/plan mode only (ask never writes), workspace open, not aborted.
    if (
      autoVerify &&
      (mode === "code" || mode === "plan") &&
      writtenFiles.size > 0 &&
      _directoryName &&
      !abortSignal?.aborted &&
      isCurrentTask(taskId)
    ) {
      for (let round = 1; round <= MAX_REPAIR_ROUNDS; round++) {
        updateTaskStatus("tool_executing", `Verifying changes (round ${round}/${MAX_REPAIR_ROUNDS})…`);
        fullDisplayContent += `\n**Verifying changes…** typecheck round ${round}/${MAX_REPAIR_ROUNDS}\n`;
        setDisplayContent(fullDisplayContent);
        emitActivity({ type: "thinking", message: `Verification round ${round}: typechecking workspace` });

        let findings = "";
  // Did the typecheck lane actually RUN? A lane that could not execute is not
  // a pass, and must never report one.
  let typecheckRan = false;
  // Reliability gate (Phase 1): when armed, the whole tiered pipeline replaces
  // the single tsc call. The repair machinery below is REUSED unchanged — the
  // pipeline only decides what `findings` contains and whether the failure is a
  // regression worth blocking on.
  let gateResult: Awaited<ReturnType<typeof runGatePipeline>> | null = null;
  if (reliabilityGatesEnabled()) {
    gateResult = await runGatePipeline({
      taskId,
      baseline: gateBaseline,
      exec: async (cmd, timeoutMs) => {
        const res = await apiFetch("/api/agent/exec", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: cmd, timeout: timeoutMs }),
          signal: abortSignal ?? undefined,
        });
        const d = await res.json();
        return { exitCode: d?.exitCode as number | undefined, stdout: d?.stdout as string, stderr: d?.stderr as string };
      },
      changedFiles: [...writtenFiles.keys()],
      includeTestLane: reliabilityTestLaneEnabled(),
      signal: abortSignal ?? undefined,
    });
    for (const r of gateResult.results) recordLaneOutcome(r.lane, r.outcome);
    fullDisplayContent += formatGateResult(gateResult) + "\n";
    setDisplayContent(fullDisplayContent);
    const tc = gateResult.results.find((r) => r.lane === "typecheck");
    typecheckRan = !!tc && tc.outcome !== "skipped";
    // Only REGRESSIONS (new errors vs the baseline) become repair findings. A
    // pre-existing failure is reported in the gate summary but must not send
    // the model chasing errors it did not cause.
    findings = gateResult.blocking
      .map((r) => `### ${r.lane} lane\n${r.findings || r.newErrors.join("\n")}`)
      .join("\n\n");
    if (tc?.outcome === "fail" && tc.newErrors.length > 0) {
      recordFailure("typecheck", tc.findings, [...writtenFiles.keys()]);
    }
  } else {
        try {
          const res = await apiFetch("/api/agent/exec", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command: VERIFY_COMMAND, timeout: VERIFY_TIMEOUT_MS }),
            signal: abortSignal ?? undefined,
          });
          const data = await res.json();
          // exitCode is absent on non-exec responses (401/500/error JSON).
          // Those are "verification unavailable" — which is NOT a pass and NOT
          // a failure. `findings` staying falsy used to fall through to
          // `if (!findings)`, printing "Verification passed — typecheck clean ✓",
          // recording a pass in the ledger, and calling clearFailures() — so an
          // unreachable verifier erased the workspace's real failure memory and
          // persisted the lie into run records.
          if (typeof data.exitCode === "number" && data.exitCode !== 0) {
            findings = summarizeTypecheckOutput(`${data.stdout || ""}\n${data.stderr || ""}`);
            // Feed the adaptive Failure Doctrine with real evidence
            recordFailure("typecheck", findings, [...writtenFiles.keys()]);
          } else if (data.exitCode === 0) {
            typecheckRan = true;
          }
        } catch {
          // exec route unavailable (e.g. unit tests without the server) — the
          // lane did NOT run. typecheckRan stays false so it is never a pass.
        }
  }

        if (!typecheckRan && !findings) {
          fullDisplayContent +=
            `**Typecheck not verified** — the typecheck lane could not run (exec route unavailable or returned no exit code). Not a pass.\n`;
          // "skipped", not "pass": computeVerdict already treats a skipped lane
          // as never-a-pass, which is exactly the truth here.
          recordLaneOutcome("typecheck", "skipped");
          setDisplayContent(fullDisplayContent);
          break;
        }

        if (!findings) {
          fullDisplayContent += `**Verification passed** — typecheck clean ✓\n`;
          recordLaneOutcome("typecheck", "pass");
          setDisplayContent(fullDisplayContent);
          clearFailures("typecheck"); // solved — drop from failure memory
          break;
        }

        if (round === MAX_REPAIR_ROUNDS) {
          fullDisplayContent += `\n**Verification still failing** after ${MAX_REPAIR_ROUNDS} repair round(s):\n\n\`\`\`\n${findings.slice(0, 1500)}\n\`\`\`\n`;
          // When the reliability gate is armed, the lane outcomes were already
          // recorded by the pipeline. Re-recording "typecheck" here would
          // clobber a real lane result, so only the legacy path stamps it.
          if (!reliabilityGatesEnabled()) recordLaneOutcome("typecheck", "fail");
          // The pipeline is red and every repair round is spent. This task did
          // NOT end verified — record that honestly so the completion site
          // stamps [FAILED] instead of reporting a clean close. Same reasoning
          // as stampFailedMessage for an empty response: a failure wearing a
          // success is worse than an visible failure.
          if (reliabilityGatesEnabled() && gateResult && gateResult.verdict === "FAIL") {
            gateRed = true;
          }
          // HARD GATE: take the edit lock so further mutations in this task are
          // refused — this is what turns "the gate reported a failure" into
          // "the gate refuses the next write". Released only by a green pipeline
          // or a task end.
          if (reliabilityEditLockEnabled() && gateResult && gateResult.verdict === "FAIL") {
            const redLanes = gateResult.blocking.map((r) => r.lane).join(", ");
            acquireEditLock(
              taskId,
              redLanes,
              `${gateResult.blocking.length} verification lane(s) still failing after ${MAX_REPAIR_ROUNDS} repair round(s)`,
            );
            fullDisplayContent += `\n**Edit lock engaged** — the ${redLanes} lane(s) are still red. Further writes are refused until they pass.\n`;
          }
          setDisplayContent(fullDisplayContent);
          break;
        }

        // Feed the failures back for one repair turn, then re-check. The
        // directive carries this workspace's REAL failure history (recurrence
        // counts, already-attempted fixes) so round 2+ repairs change strategy
        // instead of repeating round 1.
        fullDisplayContent += `**Verification failed** — ${findings.split("\n").length} error(s), repairing…\n`;
        setDisplayContent(fullDisplayContent);
        emitActivity({ type: "thinking", message: "Verification failed — auto-repairing" });
        if (lastStreamedContent) apiMessages.push({ role: "assistant", content: lastStreamedContent });
        const failureCtx = adaptiveFailureDoctrine();
        apiMessages.push({
          role: "user",
          content: failureCtx
            ? `${buildVerificationRepairPrompt(findings, [...writtenFiles.keys()])}\n\n${failureCtx}`
            : buildVerificationRepairPrompt(findings, [...writtenFiles.keys()]),
        });
        recordRepairAttempt(`typecheck repair round ${round}: ${findings.split("\n")[0]?.slice(0, 120) || "errors"}`);

        const repairStream = await callModel(
          apiMessages,
          runState,
          conversationId,
          {
            onChunk: (c) => setDisplayContent(composeDisplay(c)),
            onThinking: (t) => {
              thinkingDisplay += t;
              setDisplayContent(composeDisplay(""));
            },
          },
          mode,
          imageDataUrls,
          abortSignal,
          effort,
          "compact", // repair turn — full doctrine already in history
          { taskId, turn: -1, why: `typecheck-repair-r${round}` }
        );
        if (abortSignal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (thinkingDisplay) {
          fullDisplayContent += repairInterleavedReplay(THINK_OPEN + thinkingDisplay + THINK_CLOSE);
          thinkingDisplay = "";
        }
        if (repairStream.content) fullDisplayContent += repairStream.content + "\n";
        lastStreamedContent = repairStream.content || lastStreamedContent;

        // Execute repair writes/edits (same tracking as the main loop so undo
        // and the files-changed counter stay accurate).
        for (const call of repairStream.toolCalls) {
          if (abortSignal?.aborted || !isCurrentTask(taskId)) return;
          if (call.name === "write_file" && call.path && call.content !== undefined) {
            updateTaskStatus("tool_executing", `Fixing ${call.path}...`);
            let ok = false;
            if (_writeFile) {
              const prevContent = _readFile ? await _readFile(call.path).catch(() => null) : null;
              const hasPrev = prevContent && !prevContent.startsWith("[Error");
              recordChange(call.path, hasPrev ? prevContent : null, call.content);
              ok = await _writeFile(call.path, call.content);
            } else {
              ok = virtualFS.writeFile(call.path, call.content);
            }
            if (ok) {
              bumpStat("toolCalls");
              totalWrites++;
              setFilesChanged(totalWrites);
              writtenFiles.set(call.path, call.content);
            }
            fullDisplayContent = replaceLastStatus(fullDisplayContent, ok ? `[SUCCESS] Fixed \`${call.path}\`` : `[ERROR] Fix failed for \`${call.path}\``);
          } else if (call.name === "edit_file" && call.path && call.old_text && call.new_text && _editFile) {
            updateTaskStatus("tool_executing", `Fixing ${call.path}...`);
            const ok = await _editFile(call.path, call.old_text, call.new_text);
            if (ok) {
              totalWrites++;
              setFilesChanged(totalWrites);
              const after = await _readFile?.(call.path).catch(() => null);
              if (after && !after.startsWith("[Error")) writtenFiles.set(call.path, after);
            }
            fullDisplayContent = replaceLastStatus(fullDisplayContent, ok ? `[SUCCESS] Fixed \`${call.path}\`` : `[FAIL] Fix failed for \`${call.path}\``);
          } else if (call.name === "batch_edit" && Array.isArray(call.edits)) {
            for (const e of call.edits as { path: string; old_text: string; new_text: string }[]) {
              if (_editFile) {
                const ok = await _editFile(e.path, e.old_text, e.new_text);
                if (ok) {
                  totalWrites++;
                  setFilesChanged(totalWrites);
                  const after = await _readFile?.(e.path).catch(() => null);
                  if (after && !after.startsWith("[Error")) writtenFiles.set(e.path, after);
                }
              }
            }
          }
          setDisplayContent(fullDisplayContent);
        }
      }
    }

    // === SWARM REVIEW: adversarial multi-agent review of written files =====
    // Coder/reviewer/tester agents critique the output server-side; findings
    // feed one repair turn. Skipped when consensus is already positive.
    if (
      autoVerify &&
      (mode === "code" || mode === "plan") &&
      writtenFiles.size > 0 &&
      !abortSignal?.aborted &&
      isCurrentTask(taskId)
    ) {
      updateTaskStatus("tool_executing", "Code review…");
      // Started before verification as a parallel lane — by the time we get
      // here it has long finished; awaiting is instant.
      fullDisplayContent += "\n**Code review:** one structured reviewer pass over the changes…\n";
      setDisplayContent(fullDisplayContent);

      const swarm = await reviewProbePromise;

      if (swarm && !swarm.consensus) {
        // Findings arrive structured ({severity, description}[]); the legacy
        // `review` text field carries the same content for repair prompting.
        const reviewText = (Array.isArray(swarm.findings) && swarm.findings.length > 0
          ? swarm.findings
              .filter((f: any) => f?.severity !== "minor")
              .map((f: any) => `[${f.severity}] ${f.description}`)
              .join("\n")
          : String(swarm.review || "")
        ).slice(0, 2000);
        if (reviewText) {
          fullDisplayContent += "**Swarm found issues — repairing…**\n";
          setDisplayContent(fullDisplayContent);
          emitActivity({ type: "thinking", message: "Swarm review flagged issues — auto-repairing" });

          if (lastStreamedContent) apiMessages.push({ role: "assistant", content: lastStreamedContent });
          apiMessages.push({
            role: "user",
            content: `[SWARM REVIEW] A panel of reviewer agents flagged these concerns in the files you wrote:\n\n${reviewText}\n\nFix the real problems with edit_file (skip stylistic nitpicks). If everything is already correct, reply explaining why.`,
          });

          const swarmStream = await callModel(
            apiMessages,
            runState,
            conversationId,
            {
              onChunk: (c) => setDisplayContent(composeDisplay(c)),
              onThinking: (t) => {
                thinkingDisplay += t;
                setDisplayContent(composeDisplay(""));
              },
            },
            mode,
            imageDataUrls,
            abortSignal,
            effort,
            "compact", // review repair turn — doctrine already in history
            { taskId, turn: -1, why: "review-repair" }
          );
          if (abortSignal?.aborted) throw new DOMException("Aborted", "AbortError");
          if (thinkingDisplay) {
            fullDisplayContent += repairInterleavedReplay(THINK_OPEN + thinkingDisplay + THINK_CLOSE);
            thinkingDisplay = "";
          }
          if (swarmStream.content) fullDisplayContent += swarmStream.content + "\n";
          lastStreamedContent = swarmStream.content || lastStreamedContent;

          for (const call of swarmStream.toolCalls) {
            if (abortSignal?.aborted || !isCurrentTask(taskId)) return;
            if (call.name === "write_file" && call.path && call.content !== undefined) {
              let ok = false;
              if (_writeFile) {
                const prevContent = _readFile ? await _readFile(call.path).catch(() => null) : null;
                const hasPrev = prevContent && !prevContent.startsWith("[Error");
                recordChange(call.path, hasPrev ? prevContent : null, call.content);
                ok = await _writeFile(call.path, call.content);
              } else {
                ok = virtualFS.writeFile(call.path, call.content);
              }
              if (ok) {
                bumpStat("toolCalls");
                totalWrites++;
                setFilesChanged(totalWrites);
                writtenFiles.set(call.path, call.content);
              }
              fullDisplayContent = replaceLastStatus(fullDisplayContent, ok ? `[SUCCESS] Fixed \`${call.path}\` (code review)` : `[ERROR] Review fix failed for \`${call.path}\``);
            } else if (call.name === "edit_file" && call.path && call.old_text && call.new_text && _editFile) {
              const ok = await _editFile(call.path, call.old_text, call.new_text);
              if (ok) {
                totalWrites++;
                setFilesChanged(totalWrites);
                const after = await _readFile?.(call.path).catch(() => null);
                if (after && !after.startsWith("[Error")) writtenFiles.set(call.path, after);
              }
              fullDisplayContent = replaceLastStatus(fullDisplayContent, ok ? `[SUCCESS] Fixed \`${call.path}\` (code review)` : `[FAIL] Review fix failed for \`${call.path}\``);
            }
            setDisplayContent(fullDisplayContent);
          }
        }
      } else if (swarm) {
        fullDisplayContent += "**Code review passed** — no blocking findings ✓\n";
        recordLaneOutcome("swarm", "pass");
        setDisplayContent(fullDisplayContent);
      } else {
        // Route unavailable / provider down — say so instead of vanishing
        // silently after announcing the review (LIVE-VALIDATED gap).
        fullDisplayContent += "*Code review unavailable (orchestration service unreachable) — skipped.*\n";
        setDisplayContent(fullDisplayContent);
      }
    }

    // === AUTO BROWSER VERIFICATION: the agent tests its own UI ============
    // After a clean typecheck on UI work, actually render the app: spawn the
    // workspace dev server, load the page in headless Chromium, capture
    // console errors. Failures feed one model repair turn, then re-verify
    // (the visual counterpart of the typecheck lane above).
    const BROWSER_VERIFY_PORT = 4310; // uncommon port; skipped if occupied
    const uiPaths = [...writtenFiles.keys()];
    if (
      autoVerify &&
      (mode === "code" || mode === "plan") &&
      uiPaths.length > 0 &&
      looksLikeUiWork(uiPaths) &&
      _directoryName &&
      !abortSignal?.aborted &&
      isCurrentTask(taskId)
    ) {
      // Port busy → a dev server (maybe the user's own) is already running:
      // never spawn a second one or screenshot the wrong app.
      let portBusy = false;
      try {
        await fetch(`http://localhost:${BROWSER_VERIFY_PORT}/`, { signal: AbortSignal.timeout(700) });
        portBusy = true;
      } catch {
        // connection refused → free
      }

      if (portBusy) {
        fullDisplayContent += "\n*Browser verification skipped — a dev server is already running.*\n";
        setDisplayContent(fullDisplayContent);
      } else {
        // Pick a dev command that matches the project (shared heuristic in
        // ui-paths.ts — same logic the server executor's verify lane uses).
        let devCommand = "npm run dev";
        try {
          const pkgRaw = _readFile ? await _readFile("package.json") : null;
          const indexRaw = _readFile ? await _readFile("index.html") : null;
          const hasPkg = !!pkgRaw && !pkgRaw.startsWith("[Error");
          const hasIndex = !!indexRaw && !indexRaw.startsWith("[Error");
          devCommand = pickDevCommand(hasPkg ? pkgRaw : null, hasIndex);
        } catch {
          // unreadable package.json — keep the default
        }

        const runBrowserVerify = async (pagePath: string): Promise<any> => {
          const res = await apiFetch("/api/agent/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workDir: _directoryName,
              devCommand,
              port: BROWSER_VERIFY_PORT,
              path: pagePath,
              recordVideo: true,
              urlPolicy: {}, // default private-host guard applies
            }),
            signal: abortSignal ?? undefined,
          });
    if (!res.ok) return { success: false, error: `verify route ${res.status}`, consoleErrors: [], timeline: [] };
    // The route's ENVELOPE `success` is always true when the harness ran; the
    // real verdict lives in `result`. Returning the envelope made
    // `if (!browserResult.success)` below unreachable, so a genuinely broken
    // UI was reported as "Browser verification passed - no console errors",
    // recorded as a pass, and had `clearFailures("browser")` wipe the
    // workspace's accumulated failure memory. Unwrap once, here.
    const data = await res.json();
    return data && data.result ? { ...data.result, runId: data.runId } : { success: false, error: "verify route returned no result", consoleErrors: [], timeline: [] };
  };

        updateTaskStatus("tool_executing", "Browser verification…");
        fullDisplayContent += "\n**Browser verification…** rendering the app\n";
        setDisplayContent(fullDisplayContent);
        emitActivity({ type: "thinking", message: "Browser verification: loading the app in a real browser" });

        let browserResult = await runBrowserVerify("/");
        let repaired = false;

        if (!browserResult.success) {
          const reasons = [
            ...(browserResult.consoleErrors || []).slice(0, 8),
            ...(browserResult.error ? [`[verify] ${browserResult.error}`] : []),
          ]
            .join("\n")
            .slice(0, 1200);

          if (reasons && !abortSignal?.aborted && isCurrentTask(taskId)) {
            fullDisplayContent += "**UI broken — repairing…**\n";
            setDisplayContent(fullDisplayContent);
            emitActivity({ type: "thinking", message: "Browser verification failed — auto-repairing" });
            recordFailure("browser", reasons, [...writtenFiles.keys()]);

            if (lastStreamedContent) apiMessages.push({ role: "assistant", content: lastStreamedContent });
            const uiFailureCtx = adaptiveFailureDoctrine();
            apiMessages.push({
              role: "user",
              content: uiFailureCtx
                ? `${browserRepairDirective(reasons)}\n\n${uiFailureCtx}`
                : browserRepairDirective(reasons),
            });
            recordRepairAttempt(`browser repair: ${reasons.split("\n")[0]?.slice(0, 120) || "render errors"}`);

            const uiRepairStream = await callModel(
              apiMessages,
              runState,
              conversationId,
              {
                onChunk: (c) => setDisplayContent(composeDisplay(c)),
                onThinking: (t) => {
                  thinkingDisplay += t;
                  setDisplayContent(composeDisplay(""));
                },
              },
              mode,
              imageDataUrls,
              abortSignal,
              effort,
              "compact", // UI repair turn — doctrine already in history
              { taskId, turn: -1, why: "browser-repair" }
            );
            if (abortSignal?.aborted) throw new DOMException("Aborted", "AbortError");
            if (thinkingDisplay) {
              fullDisplayContent += repairInterleavedReplay(THINK_OPEN + thinkingDisplay + THINK_CLOSE);
              thinkingDisplay = "";
            }
            if (uiRepairStream.content) fullDisplayContent += uiRepairStream.content + "\n";
            lastStreamedContent = uiRepairStream.content || lastStreamedContent;

            // Execute repair writes (same tracking as every other repair turn)
            for (const call of uiRepairStream.toolCalls) {
              if (abortSignal?.aborted || !isCurrentTask(taskId)) return;
              if (call.name === "write_file" && call.path && call.content !== undefined) {
                updateTaskStatus("tool_executing", `Fixing ${call.path}…`);
                let ok = false;
                if (_writeFile) {
                  const prevContent = _readFile ? await _readFile(call.path).catch(() => null) : null;
                  const hasPrev = prevContent && !prevContent.startsWith("[Error");
                  recordChange(call.path, hasPrev ? prevContent : null, call.content);
                  ok = await _writeFile(call.path, call.content);
                } else {
                  ok = virtualFS.writeFile(call.path, call.content);
                }
                if (ok) {
                  bumpStat("toolCalls");
                  totalWrites++;
                  setFilesChanged(totalWrites);
                  writtenFiles.set(call.path, call.content);
                }
                fullDisplayContent = replaceLastStatus(fullDisplayContent, ok ? `[SUCCESS] Fixed \`${call.path}\` (browser verification)` : `[ERROR] Fix failed for \`${call.path}\``);
              } else if (call.name === "edit_file" && call.path && call.old_text && call.new_text && _editFile) {
                updateTaskStatus("tool_executing", `Fixing ${call.path}…`);
                const ok = await _editFile(call.path, call.old_text, call.new_text);
                if (ok) {
                  totalWrites++;
                  setFilesChanged(totalWrites);
                  const after = await _readFile?.(call.path).catch(() => null);
                  if (after && !after.startsWith("[Error")) writtenFiles.set(call.path, after);
                }
                fullDisplayContent = replaceLastStatus(fullDisplayContent, ok ? `[SUCCESS] Fixed \`${call.path}\` (browser verification)` : `[FAIL] Fix failed for \`${call.path}\``);
              }
              setDisplayContent(fullDisplayContent);
            }

            repaired = true;
            // Emit preview navigation so the live panel shows the verified app
            emitPreview(`http://localhost:${BROWSER_VERIFY_PORT}/`, "verify_app");
            browserResult = await runBrowserVerify("/");
          }
        }

        if (browserResult.success) {
          const shot = browserResult.screenshotPath ? ` (screenshot: ${String(browserResult.screenshotPath).split(/[\\/]/).pop()})` : "";
          fullDisplayContent += `**Browser verification passed ✓**${shot} — no console errors\n`;
          recordLaneOutcome("browser", "pass");
          clearFailures("browser"); // solved — drop from failure memory
        } else if (repaired) {
          const errs = (browserResult.consoleErrors || []).slice(0, 3).join("; ") || browserResult.error || "unknown";
          fullDisplayContent += `**Browser verification still failing** after repair: ${String(errs).slice(0, 200)}\n`;
          recordLaneOutcome("browser", "fail");
        } else {
          // Couldn't run at all (no Playwright, spawn failure) — note, don't fail the task
          fullDisplayContent += `*Browser verification unavailable — skipped.*\n`;
        }
        setDisplayContent(fullDisplayContent);
      }
    }

    // Keep [THINKING] content so ThinkingCard can render it after completion
    let cleanContent = fullDisplayContent
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // FILES-NOT-FENCES display guard: when the task wrote real files, full
    // fences of that content in the final answer are redundant bulk (Prime
    // Directive #1 — LIVE-VALIDATED: the model pasted the whole 142-line HTML
    // after write_file succeeded). Small snippets pass; the ThinkingCard is
    // preserved verbatim.
    cleanContent = stripRedundantFences(cleanContent, { filesWritten: writtenFiles.size > 0 });

    // NOTE (consolidation): no semantic-cache write — task outcomes persist
    // via the run ledger + workspace learnings (the permanent buckets).

    // === CODE BLOCK EXTRACTION ===
    // If AI output markdown code blocks instead of using write_file,
    // extract them and write as files automatically. CODE/PLAN modes only —
    // in ASK mode the code blocks are the answer, not files to create.
    let extractedFiles = 0;
    if (mode !== "ask" && totalWrites === 0 && virtualFS.getFileCount() === 0) {
      // No files were created via tools — check for code blocks in output
      const codeBlockRegex = /```(\w+)?\s*(?:\w+)?\s*\n([\s\S]*?)```/g;
      let codeMatch;
      const headerRegex = /^(?:\d+\.\s*)?([A-Za-z .]+)\s*$/m;

      // Find section headers before code blocks to determine filenames
      while ((codeMatch = codeBlockRegex.exec(cleanContent)) !== null) {
        const lang = (codeMatch[1] || "text").toLowerCase();
        const code = codeMatch[2].trim();
        if (code.length < 10) continue; // Skip tiny snippets

        // Determine filename from language
        const extMap: Record<string, string> = {
          html: ".html", htm: ".html", css: ".css", js: ".js",
          javascript: ".js", typescript: ".ts", ts: ".ts",
          tsx: ".tsx", jsx: ".tsx", json: ".json", python: ".py",
          py: ".py", md: ".md", sh: ".sh", bash: ".sh",
          prisma: ".prisma", sql: ".sql", yaml: ".yml",
          yml: ".yml", toml: ".toml", xml: ".xml",
        };
        const ext = extMap[lang] || ".txt";

        // Try to find a section header above the code block
        const beforeBlock = cleanContent.slice(Math.max(0, codeMatch.index - 200), codeMatch.index);
        const sectionMatch = beforeBlock.match(/(?:\d+\.\s*)?([A-Za-z][A-Za-z .\-]+)$/m);
        let fileName = "generated-file" + ext;

        if (sectionMatch) {
          const sectionTitle = sectionMatch[1].trim().toLowerCase()
            .replace(/[^a-z0-9\s]/g, "")
            .replace(/\s+/g, "-")
            .slice(0, 40);
          if (sectionTitle.length > 2) {
            fileName = sectionTitle + ext;
          }
        }

        // Deduplicate filenames
        if (virtualFS.exists(fileName)) {
          const base = fileName.replace(/\.[^.]+$/, "");
          const ext2 = fileName.match(/\.[^.]+$/)?.[0] || ext;
          let counter = 2;
          while (virtualFS.exists(`${base}-${counter}${ext2}`)) counter++;
          fileName = `${base}-${counter}${ext2}`;
        }

        // Write to local FS if a folder is open, otherwise to virtual FS
        if (_writeFile) {
          await _writeFile(fileName, code);
        } else {
          virtualFS.writeFile(fileName, code);
        }
        extractedFiles++;
      }

      if (extractedFiles > 0) {
        // Replace code blocks with file references in display
        cleanContent = cleanContent.replace(
          /```(\w+)?\s*(?:\w+)?\s*\n[\s\S]*?```/g,
          ""
        );
        cleanContent += `\n\n[${extractedFiles} file(s) extracted from code blocks and saved to workspace]`;
      }
    }

    // If files were written, append a preview guide
    const virtualFileCount = virtualFS.getFileCount();
    const hasFiles = totalWrites > 0 || virtualFileCount > 0 || extractedFiles > 0;

    if (hasFiles) {
      const fileCount = totalWrites > 0 ? totalWrites : (virtualFileCount > 0 ? virtualFileCount : extractedFiles);
      let guide = "\n\n---\n\n";
      guide += `${fileCount} file(s) created.\n`;

      if (_directoryName) {
        guide += "Files saved to your open folder. Check the sidebar file tree to browse them.\n";
        guide += "To preview: open a terminal and run `npx serve .` or `python -m http.server 3001`.\n";
        guide += "Then open http://localhost:3001 in your browser.";
      } else {
        guide += "Files are in the virtual workspace.\n";
        guide += "Click 'Open' in the sidebar to sync with a local folder,\n";
        guide += "or click 'Export .zip' to download all files.\n";
        guide += "To preview: export the .zip, extract it, then run `npx serve .` or `python -m http.server 3001`.";
      }
      cleanContent += guide;
    }

    // Prompt-meter summary: full vs compact savings for this task, visible
    // in the transcript and logged as a console table for inspection.
    try {
      const savings = computeTaskSavings(taskId);
      savingsPct = savings ? savings.savedPct : null;
      modelCallCount = savings ? savings.calls : 0;
      const meterLine = formatSavingsSummary(taskId);
      if (meterLine) {
        cleanContent += `\n\n---\n\n*${meterLine}*\n`;
        logTaskMeter(taskId);
      }
    } catch {}

    // Test-mode rubric recording: grade the run deterministically from the
    // platform's own evidence and append to the trend history (no-op unless
    // TEST_MODE=1 or a live session enabled it).

    // Ensure display content is set one final time (covers edge cases)
    // Normalize reasoning blocks: the ThinkingCard stays (user asked to keep
    // thinking visible), but malformed markers can never bleed reasoning into
    // the main answer text.
    // Final assembly re-sweeps everything (idempotent on already-repaired
    // blocks): phrase-level replay repair → word-level dedup → normalization.
    const rawFinalContent = normalizeThinkingBlocks(deduplicateWords(repairInterleavedReplay(cleanContent || fullDisplayContent)));
    let finalContent = rawFinalContent;
    // A task whose gate is STILL red after every repair round did not end
    // verified — the files are written but the workspace does not compile.
    // Record that honestly everywhere the terminal status is written (rubric
    // ledger, run ledger, memory, UI) so a red close can never be reported as
    // a clean one. Same reasoning as stampFailedMessage for an empty response:
    // a failure wearing a success is worse than a visible failure.
    const finalStatus: "done" | "error" = gateRed ? "error" : "done";
    setDisplayContent(finalContent);
    if (isRecordingEnabled()) {
      try {
        const record = finishRubricObservation(finalStatus, finalContent, { modelCalls: modelCallCount, tokenSavingsPct: savingsPct });
        if (record) console.log("\n=== RUBRIC TREND ===\n" + formatTrendReport(readTrendHistoryForReport()) + "\n");
      } catch {}
    }
    // Persistent ledger: record the run (lanes + economics) and unresolved
    // failures so the agent's memory survives restarts. Passing lanes also
    // resolve their open failure signatures server-side.
    try {
      const meta = getObservationMeta();
      const lanes = meta?.lanes || { typecheck: "skipped", browser: "skipped", swarm: "skipped" };
      const payload = buildFinalizePayload({
        taskId,
        workspaceKey: getWorkspaceKey(_directoryName),
        task: userMessage,
        mode,
        finalStatus,
        lanes,
        durationMs: meta?.durationMs || 0,
      });
      postRunToLedger(payload).catch(() => {});
      // Workspace memory: report this run's outcome to the memory API (the
      // server derives + persists learnings — the client never touches Prisma).
      try {
        const { captureMemoriesViaApi } = await import("./workspace-memory-client");
        const writtenObj: Record<string, string> = {};
        for (const [p, c] of writtenFiles) writtenObj[p] = c;
        captureMemoriesViaApi({
          workspaceKey: getWorkspaceKey(_directoryName),
          task: userMessage,
          writtenFiles: writtenObj,
          lanes: { typecheck: lanes.typecheck, browser: lanes.browser },
          finalStatus,
          directoryName: _directoryName ?? "",
        } as never);
      } catch {}
    } catch {}
    // Stale check: don't complete if user stopped/started a new task
    if (isCurrentTask(taskId) && !abortSignal?.aborted) {
      clearPlanLatch(taskId);
      // Reliability gate: the task is closing. Drop any edit lock so a red
      // close cannot wedge the NEXT task — the lock's job is to refuse writes
      // while a gate is red WITHIN a task, not to punish the next one.
      releaseEditLock(taskId);
      // A model that answered empty (no text, no tools) is a failure wearing a
      // success: stamp the bubble [FAILED] so Retry is offered. (The stamp
      // rides the final content — failTask/completeTask content is what the
      // subscriber writes into the placeholder.)
      if (failedEmptyResponse) {
        // A response that came back empty while the machine is low on RAM gets
        // the live percentage appended, so the failure explains itself.
        const memNote = await lowMemoryNote();
        const withNote = memNote
          ? `${finalContent ? finalContent + "\n\n" : ""}${memNote}`
          : finalContent;
        finalContent = stampFailedMessage(withNote);
      }
      if (gateRed) {
        // The gate is still red after every repair round. Stamp the bubble
        // [FAILED] so Retry is offered, exactly like an empty response — but
        // keep the full gate report in the content above the stamp, because
        // the user needs the findings to fix it. failTask preserves whatever
        // was last set as display content and flips status to error.
        const gateReason = `verification gate still red after ${MAX_REPAIR_ROUNDS} repair round(s) — the workspace does not compile`;
        finalContent = stampFailedMessage(`${finalContent}\n\n**Task closed as FAILED** — ${gateReason}.`);
        setDisplayContent(finalContent);
        failTask(gateReason);
        // === PLUGIN HOOK: onTaskFail ===
        onTaskFail(userMessage, gateReason).catch(() => {});
      } else {
        completeTask(finalContent);
        // === PLUGIN HOOK: onTaskComplete ===
        onTaskComplete(userMessage, finalContent, {
          files: Object.fromEntries(writtenFiles),
          lanes: getObservationMeta()?.lanes as Record<string, string> | undefined,
          finalStatus,
        }).catch(() => {});
      }
    }
  } catch (err) {
    const aborted = abortSignal?.aborted === true;
    if (isCurrentTask(taskId)) {
      if (aborted) {
        // User pressed Stop — keep whatever partial output we have so the
        // subscriber can write it back, but don't mark the task failed. Fold
        // any open thinking block so the ThinkingCard survives in the saved
        // message instead of the raw reasoning rendering as plain text.
        if (fullDisplayContent.trim()) {
          const partial = normalizeThinkingBlocks(
            deduplicateWords(
              repairInterleavedReplay(
                fullDisplayContent.trim() +
                (thinkingDisplay ? THINK_OPEN + thinkingDisplay + THINK_CLOSE : "")
              )
            )
          );
          setDisplayContent(partial);
        }
        // Reliability gate: an aborted task must not leak an edit lock.
        releaseEditLock(taskId);
        return;
      }
      const errMsg = String((err as Error)?.message || "Unknown error");
      // Token-limit failures get an actionable message instead of a raw 413.
      const friendly = TOKEN_LIMIT_RE.test(errMsg)
        ? "Groq's free tier allows 8,000 tokens per minute and this task exceeded it even after trimming the context. Start a new chat (shorter history), or add your own Groq API key in Settings → API Keys for larger limits."
        : errMsg;
      // Low-memory failures explain themselves: append the live RAM percentage
      // when the machine is under pressure, and land the message IN the bubble
      // (stamped [FAILED]) so the user sees why the response died + Retry.
      const memNote = await lowMemoryNote();
      const failMsg = memNote ? `${friendly} — ${memNote}` : friendly;
      const partial = fullDisplayContent.trim()
        ? normalizeThinkingBlocks(deduplicateWords(repairInterleavedReplay(fullDisplayContent.trim())))
        : "";
      setDisplayContent(stampFailedMessage(partial ? `${partial}\n\n${failMsg}` : failMsg));
      // Reliability gate: a failed task must not leak an edit lock into the
      // next one. Same reasoning as the success path.
      releaseEditLock(taskId);
      failTask(failMsg);
      // === PLUGIN HOOK: onTaskFail ===
      onTaskFail(userMessage, failMsg).catch(() => {});
      // Test-mode rubric recording for FAILED runs — regressions live here.
      if (isRecordingEnabled()) {
        try {
          finishRubricObservation("error", fullDisplayContent, { modelCalls: modelCallCount, tokenSavingsPct: savingsPct });
        } catch {}
      }
      // Persistent ledger for FAILED runs — the most valuable lessons.
      try {
        const meta = getObservationMeta();
        const payload = buildFinalizePayload({
          taskId,
          workspaceKey: getWorkspaceKey(_directoryName),
          task: userMessage,
          mode,
          finalStatus: "error",
          lanes: meta?.lanes || { typecheck: "skipped", browser: "skipped", swarm: "skipped" },
          durationMs: meta?.durationMs || 0,
        });
        postRunToLedger(payload).catch(() => {});
      } catch {}
    }
  }
}
