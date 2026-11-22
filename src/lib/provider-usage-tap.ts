/**
 * provider-usage-tap.ts — read the provider's own token accounting off the
 * raw SSE stream without touching it.
 *
 * /api/chat hands the provider stream to `sseTransform` and never looks at
 * `usage`. The context ring prefers the provider's `prompt_tokens` over our
 * chars/4 estimate, so we branch the stream, scan the provider's JSON chunks
 * for `prompt_tokens` and the model id, and record the reading.
 *
 * Failure-safe by construction: the tap branch is consumed and discarded, any
 * parse error is ignored, and the returned stream is the untouched original.
 */

import { recordPromptUsage } from "@/lib/context-usage";

const MAX_SCAN_BYTES = 2_000_000;

/** Pull the largest `prompt_tokens` and the first `"model"` string out of a chunk. */
export function scanUsageChunk(text: string): { promptTokens: number | null; model: string | null } {
  let promptTokens: number | null = null;
  const tokenRe = /"prompt_tokens"\s*:\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text))) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && (promptTokens === null || n > promptTokens)) promptTokens = n;
  }
  let model: string | null = null;
  const modelRe = /"model"\s*:\s*"([^"\\]{1,120})"/;
  const mm = modelRe.exec(text);
  if (mm) model = mm[1];
  return { promptTokens, model };
}

/**
 * Branch `stream`, record the provider's prompt size for `conversationId`,
 * and return the stream unchanged.
 */
export function tapProviderUsage(stream: ReadableStream<Uint8Array>, conversationId: string | null): ReadableStream<Uint8Array> {
  if (!conversationId) return stream;
  try {
    const [passthrough, probe] = stream.tee();
    void (async () => {
      const reader = probe.getReader();
      const decoder = new TextDecoder();
      let scanned = 0;
      let tokens: number | null = null;
      let model: string | null = null;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          scanned += value.byteLength;
          const found = scanUsageChunk(decoder.decode(value, { stream: true }));
          if (found.promptTokens && (!tokens || found.promptTokens > tokens)) tokens = found.promptTokens;
          if (found.model && !model) model = found.model;
          if (tokens && scanned > MAX_SCAN_BYTES) break;
        }
      } catch {
        // A broken probe branch must never surface: the chat already streamed.
      }
      if (tokens) recordPromptUsage(conversationId, { tokens, model });
    })();
    return passthrough;
  } catch {
    // tee() unavailable (already-locked stream) — the estimate stands in.
    return stream;
  }
}
