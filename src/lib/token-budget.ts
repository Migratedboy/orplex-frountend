/**
 * token-budget.ts — token budgeting + TPM pacing for the worker's model calls,
 * extracted verbatim from background-worker.ts (Operation Modularity).
 *
 * Two protections live here:
 *   1. fitMessagesToBudget — trim older messages before every model call
 *   2. reserveTokenWindow — pace requests so a 60s window is never exceeded
 *
 * RATE LIMIT vs CONTEXT WINDOW are different things: TPM_LIMIT only paces
 * request timing; the message budget derives from the model's real context
 * window (resolved from the catalog), never from the rate limit.
 *
 * The worker's prompt-meter calibration (calibratePromptSizes) deliberately
 * STAYED in background-worker.ts — it is that module's own load-time side
 * effect and its timing must not move.
 */
import { updateTaskStatus } from "./background-chat";

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

export async function contextWindowForModel(model?: string): Promise<number> {
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

const SYSTEM_PROMPT_TOKENS = 3300; // CODE-mode stack: M3 + techniques + enhanced (added by /api/chat)
export const OUTPUT_RESERVE = 1800; // room for the model's reply
// Headroom inside the window for everything that is NOT conversation history:
// the system prompt, the reply, and MCP tool schemas. Sized from THIS model's
// real window (never from the rate limit, and never from a global constant).
export const msgBudgetFor = (contextWindow: number) =>
  Math.min(
    Math.floor(contextWindow * COMPACTION_TRIGGER_RATIO),
    contextWindow - SYSTEM_PROMPT_TOKENS - OUTPUT_RESERVE - TPM_SAFETY
  );
export const SENT_LOG: { t: number; tokens: number }[] = [];

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
    // The task anchor rides the TAIL of the last message (appendTaskAnchor) so
    // oldest-first dropping can never lose it — but a plain head-slice cut the
    // anchor off exactly when the budget was tightest. Split it out: cap the
    // base to leave the anchor room and always keep the anchor tail verbatim.
    const anchorAt = content.lastIndexOf("\n\n---\n[ORIGINAL TASK");
    if (anchorAt >= 0) {
      const anchor = content.slice(anchorAt);
      const base = content.slice(0, anchorAt);
      const raw = base.slice(0, Math.max(0, charCap - anchor.length));
      let cut = raw;
      const lastNl = cut.lastIndexOf("\n");
      if (lastNl > cut.length * 0.5) cut = cut.slice(0, lastNl); // keep ≥50% of the head
      return cut + (raw.length < base.length ? marker : "") + anchor;
    }
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
  export async function reserveTokenWindow(tokens: number, abortSignal?: AbortSignal | null): Promise<void> {
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

export const TOKEN_LIMIT_RE = /tokens per minute|Request too large|\b413\b/i;
