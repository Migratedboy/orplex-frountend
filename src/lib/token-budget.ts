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
// Historical: a previous free tier capped requests at ~8,000 tokens/MINUTE
// and stacked prompts (8.4k-27k observed) died with HTTP 413. That tier was
// removed (2026-11-09). Two protections remain for any future capped tier:
//   1. fitMessagesToBudget - trim older messages before every model call
//   2. reserveTokenWindow - pace requests so a 60s window is never exceeded

const CHARS_PER_TOKEN = 4;

// RATE LIMIT vs CONTEXT WINDOW are different things and were conflated here.
// TPM_LIMIT is a throughput ceiling (tokens per MINUTE) and only paces request
// timing via reserveTokenWindow — it must never size the transcript. Deriving
// the message budget from it produced MSG_BUDGET_TOKENS = 2500, so compaction
// fired after ~3 messages and the divider read "6k -> 2k".
const TPM_LIMIT = 8000; // legacy ceiling value; no lane maps to it now
const TPM_SAFETY = 400; // counting-error margin

/**
 * Effective TPM ceiling for a model. Only models with a KNOWN per-minute
 * token ceiling are paced; everything else is unlimited here and relies on
 * the provider's own 429 + Retry-After handling.
 */
const KNOWN_TPM_MODELS: Record<string, number> = {
  // No remaining lane has a known per-minute token ceiling (Groq free tier
  // removed 2026-11-09). The pacer therefore always finds "unlimited" and
  // returns immediately; the provider's own 429 + Retry-After is the
  // authority. Add an entry here if a future free tier actually caps TPM.
};

export function tpmLimitForModel(model?: string): number {
  const env = Number(process.env.ORPLEX_TPM_LIMIT);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  if (!model) return Number.POSITIVE_INFINITY; // no lane is paced (Groq removed 2026-11-09)
  const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return KNOWN_TPM_MODELS[model] ?? KNOWN_TPM_MODELS[bare] ?? Number.POSITIVE_INFINITY;
}

// Real per-model context window. There is deliberately NO global default
// window: models here range from ~8k to 1M, so any single hardcoded number
// either starves small-context models or overflows them.
//
// Resolution order is the SAME one the context meter shows the user, or the two
// lanes disagreed: this function used to read the verified catalog only, which
// is empty until a provider sweep succeeds — so every model measured 32k and a
// 1M-token model compacted at 12.8k. Catalog → app registry → conservative 32k.
const FALLBACK_CONTEXT_TOKENS = 32_000;
// Compact at half the model's window: leaves room for the system prompt, the
// next reply, and MCP tool schemas without ever hitting the hard limit.
const COMPACTION_TRIGGER_RATIO = 0.5;

export async function contextWindowForModel(model?: string): Promise<number> {
  if (!model) return FALLBACK_CONTEXT_TOKENS;
  try {
    const { resolveContextLimit } = await import("./context-limit");
    const resolved = await resolveContextLimit(model);
    if (resolved.limit > 0) return resolved.limit;
  } catch {
    /* fall through to the safe number */
  }
  return FALLBACK_CONTEXT_TOKENS;
}

// Measured, not guessed: the CODE-mode stack (M3 + techniques + enhanced) plus
// the workspace block measures 4,034 tokens on a real project; ask mode is
// 1,172 and plan mode 3,634. Reserve the worst case.
const SYSTEM_PROMPT_TOKENS = 4_100;
// The 76-tool code roster is 6,728 tokens of JSON schema ON TOP of the system
// prompt, and it rides in every code-mode request. Leaving it out of the
// reserve meant a 16k-class window could be over-filled before the transcript
// even started (8,000 budget + 10,762 overhead > 16,000).
const TOOL_SCHEMA_TOKENS = 6_800;
export const OUTPUT_RESERVE = 1800; // room for the model's reply
// Headroom inside the window for everything that is NOT conversation history:
// the system prompt, the reply, and MCP tool schemas. Sized from THIS model's
// real window (never from the rate limit, and never from a global constant).
export const msgBudgetFor = (contextWindow: number) =>
  Math.max(
    0,
    Math.min(
      Math.floor(contextWindow * COMPACTION_TRIGGER_RATIO),
      contextWindow - SYSTEM_PROMPT_TOKENS - TOOL_SCHEMA_TOKENS - OUTPUT_RESERVE - TPM_SAFETY
    )
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

  /**
   * Cut at a line boundary and mark exactly what the cut was. The marker is
   * reserved out of the cap, so a trimmed message never lands ABOVE the budget
   * it was trimmed to (it used to overshoot by the marker's own length).
   */
  const capWithMarker = (content: string, charCap: number, marker: string) => {
    const cap = Math.max(0, charCap - marker.length);
    // The task anchor rides the TAIL of the last message (appendTaskAnchor) so
    // oldest-first dropping can never lose it — but a plain head-slice cut the
    // anchor off exactly when the budget was tightest. Split it out: cap the
    // base to leave the anchor room and always keep the anchor tail verbatim.
    const anchorAt = content.lastIndexOf("\n\n---\n[ORIGINAL TASK");
    if (anchorAt >= 0) {
      const anchor = content.slice(anchorAt);
      const base = content.slice(0, anchorAt);
      const raw = base.slice(0, Math.max(0, cap - anchor.length));
      let cut = raw;
      const lastNl = cut.lastIndexOf("\n");
      if (lastNl > cut.length * 0.5) cut = cut.slice(0, lastNl); // keep ≥50% of the head
      return cut + (raw.length < base.length ? marker : "") + anchor;
    }
    const raw = content.slice(0, cap);
    let cut = raw;
    const lastNl = cut.lastIndexOf("\n");
    if (lastNl > cap * 0.5) cut = cut.slice(0, lastNl); // keep ≥50% of the head
    return cut + (raw.length < content.length ? marker : "");
  };

  // A trimmed TOOL RESULT and a trimmed USER message are not the same event:
  // the first is the model re-reading its own output, the second is the user's
  // paste/attachment being too big for this model — say which one happened.
  const toolMarker =
    "\n…[TOOL OUTPUT SHORTENED FOR CONTEXT BUDGET — the middle was cut here, the FILE ITSELF is complete; use line ranges to re-check specifics]";
  const userMarker =
    "\n…[MESSAGE SHORTENED FOR CONTEXT BUDGET — this message (or its attached files) was longer than the model's window allows, so the tail was cut here. Ask for the rest in a follow-up if you need it]";

  // 1. Cap every message except the last (tool results & old turns)
  const OLDER_CAP = 800; // tokens
  for (let i = 0; i < out.length - 1; i++) {
    if (estimateTokens(out[i].content) > OLDER_CAP) {
      out[i].content = capWithMarker(
        out[i].content,
        OLDER_CAP * CHARS_PER_TOKEN,
        out[i].role === "user"
          ? "\n…[OLDER MESSAGE SHORTENED FOR CONTEXT BUDGET — the middle was cut here]"
          : toolMarker
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
        last.role === "user" ? userMarker : toolMarker
      );
    }
  }
  return out;
}

/**
 * Pace requests so the tokens sent in any rolling 60s window stay under the
 * provider's TPM limit. Sleeps (with a status update) when the window is full.
 */
  /**
 * Reserve `tokens` against the rolling 60s window and wait (with status
 * updates) exactly until the window has room — no invented provider reset,
 * the wait is computed from OUR OWN accounting.
 */
export async function reserveTokenWindow(tokens: number, abortSignal?: AbortSignal | null, model?: string): Promise<void> {
  const limit = tpmLimitForModel(model);
  // No known per-minute ceiling for this lane — pacing here would be
  // throttling against nothing. The provider's own 429/Retry-After is the
  // authority (handled by the retry ladders).
  if (!Number.isFinite(limit)) return;
  const pruned = prunedLog();
  const used = pruned.reduce((s, e) => s + e.tokens, 0);
  if (used + tokens <= limit - TPM_SAFETY) {
    SENT_LOG.push({ t: Date.now(), tokens });
    return;
  }
  // Sliding window: walk oldest-first and find when enough tokens have aged
  // out. Honest math replaces the old uniform-rate guess + arbitrary 65s cap.
  let remaining = used;
  let waitMs = 0;
  for (const e of [...pruned].sort((a, b) => a.t - b.t)) {
    remaining -= e.tokens;
    waitMs = 60_000 - (Date.now() - e.t);
    if (remaining + tokens <= limit - TPM_SAFETY) break;
  }
  waitMs = Math.max(0, Math.min(waitMs, 60_000));
  updateTaskStatus("streaming", `Queued: waiting ${Math.ceil(waitMs / 1000)}s (our token budget, ${limit}/min)...`);
  console.info(JSON.stringify({
    event: "token_window_wait", level: "info", waitMs,
    used, requested: tokens, limit, logSize: pruned.length,
  }));
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (abortSignal?.aborted) return;
    await new Promise((r) => setTimeout(r, Math.min(250, deadline - Date.now())));
  }
  if (abortSignal?.aborted) return;
  // Fail open if our accounting still shows no room: the provider's own
  // 413 path (with retry + backoff) is the authority, not our estimate.
  const postWaitUsed = prunedLog().reduce((s, e) => s + e.tokens, 0);
  if (postWaitUsed + tokens > limit) return;
  SENT_LOG.push({ t: Date.now(), tokens });
}

/** Rolling 60s view of the sent log (prunes expired entries in place). */
export function prunedLog(now = Date.now()): Array<{ t: number; tokens: number }> {
  for (let i = SENT_LOG.length - 1; i >= 0; i--) {
    // A token exactly 60s old is outside the rolling window.
    if (now - SENT_LOG[i].t >= 60_000) SENT_LOG.splice(i, 1);
  }
  return SENT_LOG;
}

export const TOKEN_LIMIT_RE = /tokens per minute|Request too large|\b413\b/i;
