// mock-ai.ts — Keyless mock AI provider for development & E2E testing
//
// When MOCK_AI=1 (never in production), /api/chat answers every request with a
// slow, deterministic fake stream instead of calling a real provider. This
// lets the FULL chat pipeline — streaming bubbles, Stop mid-stream, resend,
// the agent loop — be exercised end-to-end with no AI keys and no quota
// consumption.
//
// The stream is emitted in the OpenAI chat-completions wire format
// (`data: {"choices":[{"delta":{"content":...}}]}`) so it rides through the
// route's existing sseTransform exactly like a real provider response,
// including the heartbeat and client-disconnect cleanup paths.

const encoder = new TextEncoder();

export function isMockAiEnabled(requestHeaders?: Headers | null): boolean {
  // The mock must never be reachable in a deployed build.
  if (process.env.NODE_ENV === "production") return false;
  // Env flag: MOCK_AI=1 on a dedicated dev server (e.g. CI / fresh machines).
  const v = process.env.MOCK_AI;
  if (v === "1" || v === "true" || v === "TRUE") return true;
  // Request-time opt-in (x-mock-ai: 1) lets the E2E suite reuse an ALREADY
  // RUNNING dev server — Next dev only allows one instance per project dir,
  // so a second dev server can't be spawned while `npm run dev` is up.
  // Playwright adds this header only to /api/chat (see e2e/helpers.ts); a
  // real deployment can never hit it because NODE_ENV is "production" there
  // AND authentication is still enforced before this branch is reached.
  const h = requestHeaders?.get("x-mock-ai");
  return h === "1" || h === "true" || h === "TRUE";
}

/** Deterministic reply body — intentionally prompt-independent so tests can
 *  assert on the markers regardless of what the worker sent on the wire. */
export function buildMockReplyText(): string {
  return [
    "MOCK_BEGIN",
    "",
    "This is a simulated streaming reply from the keyless MOCK_AI provider.",
    "It exists so the full chat pipeline — streaming bubbles, Stop mid-stream,",
    "and resend — can be exercised end-to-end without real AI keys.",
    "The reply is emitted slowly and deterministically so automated tests can",
    "interrupt it at any point in the stream.",
    "MOCK_END",
  ].join("\n");
}

/**
 * Emits the mock reply as an OpenAI-compatible SSE provider stream.
 *
 * ~330 chars ÷ 6-char slices at 90ms ≈ 5s of visible streaming — long enough
 * for a test to reliably press Stop while the reply is mid-flight, short
 * enough to keep the suite fast. `cancel()` stops the timer so an aborted
 * request never keeps ticking server-side.
 */
export function createMockProviderStream(): ReadableStream<Uint8Array> {
  const text = buildMockReplyText();
  const SLICE = 6; // chars per tick
  const TICK_MS = 90;
  let offset = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        if (offset >= text.length) {
          if (timer) clearInterval(timer);
          timer = null;
          try {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch {
            /* stream already cancelled */
          }
          return;
        }
        const piece = text.slice(offset, offset + SLICE);
        offset += SLICE;
        const payload = JSON.stringify({ choices: [{ delta: { content: piece } }] });
        try {
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch {
          /* stream already cancelled */
        }
      }, TICK_MS);
    },
    cancel() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  });
}
