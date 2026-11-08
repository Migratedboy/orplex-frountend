/**
 * model-call.ts — prepares and performs one worker model turn.
 *
 * Run state is passed by the caller so overlapping tasks keep independent
 * anchors, compaction state, and memory telemetry.
 */
import { updateTaskStatus } from "./background-chat";
import { emitActivity, emitCompaction } from "./agent-events";
import { readStream, appendTaskAnchor, type StreamCallbacks, type StreamResult } from "./stream-reader";
import { configureCache, searchCache, cacheResponse } from "./semantic-cache";
import {
  MODEL_RESPONSE_ATTEMPTS,
  modelRetryCountdownSeconds,
  modelAttemptLabel,
} from "./model-retry-ladder";
import { recordPromptCall } from "./prompt-meter";
import {
  SENT_LOG,
  TOKEN_LIMIT_RE,
  OUTPUT_RESERVE,
  contextWindowForModel,
  estimateTokens,
  fitMessagesToBudget,
  msgBudgetFor,
  reserveTokenWindow,
} from "./token-budget";

/** State owned by one run and threaded through its model calls. */
export interface RunState {
  /** The original task text - keeps the task anchored in the trimmed context. */
  anchorTaskMessage: string;
  /** Lazily created per-run summarizing compactor (see compaction.ts). */
  taskCompactor: import("./compaction").TranscriptCompactor | null;
  /** Eviction high-water mark, so one logical compaction emits one divider. */
  lastCompactedThrough: number;
  /** How many memory entries were injected, for the run record. */
  taskMemoriesUsed: number;
  /**
   * Body of the most recent <context_so_far> summary produced by the
   * compactor. The turn loop consumes it for one turn and then clears it.
   */
  lastCompactionSummary: string | null;
}

// Cache configuration is initialized by background-worker at its previous
// load-time position, after prompt-meter calibration.
let cacheEnabled = false;

export function initializeModelCall(): void {
  cacheEnabled = process.env.SEMANTIC_CACHE === "1";
  if (cacheEnabled) {
    try {
      configureCache({ enabled: true });
    } catch {}
  }
}

function summarizeForDisplay(compacted: Array<{ content?: string }>): string | undefined {
  const first = compacted?.[0]?.content ?? "";
  const m = first.match(/<context_so_far>\s*([\s\S]*?)\s*<\/context_so_far>/i);
  const body = (m?.[1] ?? "").trim();
  return body.length > 0 ? body : undefined;
}

/**
 * Model call with budget fitting + pacing + adaptive retry on TPM 413s.
 * Mirrors readStream's signature - all worker model calls go through here.
 */
export async function callModel(
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
  // Resolve the real context window before truncation, so the fallback path
  // uses the same budget as compaction.
  const MSG_BUDGET_TOKENS = msgBudgetFor(await contextWindowForModel(model));
  // Summarizing compaction BEFORE truncation: when the transcript outgrows
  // the budget, evicted messages become a <context_so_far> summary instead of
  // being dropped. Incremental state = one bounded summary call per eviction.
  // Any failure falls back to fitMessagesToBudget below — never blocks a task.
  let fitted = fitMessagesToBudget(anchored, MSG_BUDGET_TOKENS);
  try {
    const { createHierarchicalCompactor } = await import("./compaction");
    runState.taskCompactor ||= createHierarchicalCompactor(async (prompt, maxTokens) => {
      // Pace summarization like every other model call; failure still resolves
      // null in compactTranscript, so compaction never blocks the task.
      await reserveTokenWindow(estimateTokens(prompt), signal);
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
      void maxTokens;
      return res.content || "";
    });
    const compacted = await runState.taskCompactor.compact(anchored, MSG_BUDGET_TOKENS, signal);
    if (compacted) {
      fitted = fitMessagesToBudget(compacted, MSG_BUDGET_TOKENS);
      runState.lastCompactionSummary = summarizeForDisplay(compacted) ?? runState.lastCompactionSummary;
      const summarizing = String(compacted[0]?.content || "").startsWith("<context_so_far>");
      if (!summarizing) {
        const trimmed = compacted.filter((m, i) => m.content !== anchored[i]?.content).length;
        emitActivity({
          type: "status",
          message: `Context compacted — ${trimmed} older tool result(s) trimmed to stay under the token budget`,
          agent: "coder",
        });
      }
      const evictedNow = summarizing ? anchored.length - compacted.length + 1 : 0;
      if (evictedNow > runState.lastCompactedThrough) {
        runState.lastCompactedThrough = evictedNow;
        const charsToTokens = (msgs: Array<{ content?: string }>) =>
          Math.round(msgs.reduce((sum, m) => sum + (m.content || "").length, 0) / 4);
        emitActivity({
          type: "status",
          message: `Context compacted — ${evictedNow} earlier turns summarized to stay under the token budget`,
          agent: "coder",
        });
        emitCompaction({
          tokensBefore: charsToTokens(anchored),
          tokensAfter: charsToTokens(fitted),
          mode: "automatic",
          summary: summarizeForDisplay(compacted),
        });
      }
    }
  } catch {}
  if (meterInfo) {
    try {
      const { getPromptSizes } = await import("./prompt-meter");
      const sizes = getPromptSizes();
      const contextChars = fitted.reduce((s, m) => s + (m.content || "").length, 0);
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
  // Retry transient provider blips with the visible 20-attempt worker ladder.
  const attempt = async (msgs: { role: string; content: string }[]): Promise<StreamResult> => {
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

    for (let n = 1; ; n++) {
      try {
        const result = await readStream(msgs, conversationId, callbacks, mode, images, signal, effort, profile, { model, mcpRemotes: sendMcpRemotes });
        if (cacheEnabled && cacheKey && result.content) {
          try { cacheResponse(cacheKey, result.content, cacheHit?.toolsUsed || []); } catch {}
        }
        return result;
      } catch (err) {
        if (signal?.aborted) throw err;
        const { isTransientError } = await import("./retry");
        if (!isTransientError(err)) throw err;
        const detail = String((err as Error)?.message || err).replace(/\s+/g, " ").slice(0, 80);
        const label = modelAttemptLabel(n);
        if (n >= MODEL_RESPONSE_ATTEMPTS) {
          updateTaskStatus("tool_executing", `${label} ${detail} — giving up`);
          emitActivity({
            type: "status",
            message: `${label} ${detail} — all ${MODEL_RESPONSE_ATTEMPTS} attempts failed`,
            agent: "coder",
          });
          throw err;
        }
        const seconds = modelRetryCountdownSeconds(n);
        emitActivity({ type: "status", message: `${label} ${detail} — retrying in ${seconds}s`, agent: "coder" });
        for (let left = seconds; left > 0; left--) {
          updateTaskStatus("tool_executing", `${label} ${detail} — retrying in ${left}s…`);
          await new Promise((r) => setTimeout(r, 1_000));
          if (signal?.aborted) throw err;
        }
      }
    }
  };
  try {
    return await attempt(fitted);
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    if (!TOKEN_LIMIT_RE.test(msg) || signal?.aborted) throw err;
    SENT_LOG.push({ t: Date.now(), tokens: OUTPUT_RESERVE + 1000 });
    const tighter = appendTaskAnchor(
      fitMessagesToBudget(apiMessages, Math.floor(MSG_BUDGET_TOKENS / 2)),
      runState.anchorTaskMessage
    );
    await reserveTokenWindow(estimate(tighter), signal);
    return await attempt(tighter);
  }
}
