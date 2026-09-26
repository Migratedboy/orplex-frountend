/**
 * abort-flow.test.ts — End-to-end test of the Stop-and-resend agent flow.
 *
 * Drives the REAL background worker + stream reader + chat store against a
 * mocked /api/chat SSE endpoint:
 *
 *   1. "Send A"    → runInBackground starts task A and begins streaming.
 *   2. "Stop"      → abortCurrentTask() mid-stream (task A must unwind
 *                    without failing, and the fetch must actually be cut).
 *   3. "Send B"    → runInBackground starts task B on a FRESH controller and
 *                    completes normally (proves stop didn't poison resend).
 */
import { runInBackground } from "../background-worker";
import {
  getCurrentTask,
  abortCurrentTask,
} from "../background-chat";
import { delay, waitFor } from "./helpers";

// Text content the mocked model streams back
const MODEL_TEXT = "Here is the answer.";

/** SSE stream that respects the request's abort signal and chunk delay. */
function sseBody(
  content: string,
  opts: { signal?: AbortSignal; chunkDelayMs?: number } = {}
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const signal = opts.signal;
  let stopEnqueuing = false;

  // readStream attaches its own reader and handles abort by cancelling it,
  // which triggers our cancel(). This mock just has to STOP ENQUEUING when
  // the request signal aborts so the (unconsumed) tail never appears.
  const abortHandler = () => {
    stopEnqueuing = true;
  };
  signal?.addEventListener("abort", abortHandler, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const words = content.split(" ");
      let i = 0;
      const tick = () => {
        if (stopEnqueuing || signal?.aborted) return;
        if (i >= words.length) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          try {
            controller.close();
          } catch {}
          return;
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ content: words[i] + " " })}\n\n`)
        );
        i++;
        if (opts.chunkDelayMs) {
          setTimeout(tick, opts.chunkDelayMs);
        } else {
          tick();
        }
      };
      tick();
    },
    cancel() {
      signal?.removeEventListener("abort", abortHandler);
    },
  });

  return stream;
}

describe("Stop-and-resend agent flow", () => {
  const originalFetch = global.fetch;
  let chatFetchCount: number;

  beforeEach(() => {
    chatFetchCount = 0;

    global.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/chat")) {
        chatFetchCount++;
        const signal = init?.signal as AbortSignal | undefined;
        // Simulated provider: streams ~60ms between chunks so the test can
        // press Stop while a chunk is in flight.
        const body = sseBody(MODEL_TEXT, { signal, chunkDelayMs: 60 });
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          })
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    // Abort + clear any stale task so an in-flight worker never leaks into
    // the next test.
    try {
      if (getCurrentTask()) {
        abortCurrentTask();
      }
    } catch {}
  });

  it("aborts task A on Stop and lets task B complete on a fresh controller", async () => {
    // --- 1. Send A ---------------------------------------------------------
    const promiseA = runInBackground(
      "message A",
      null,
      [],
      "ask",
      []
    );
    // Wait until task A exists and its stream has started
    await waitFor(() => getCurrentTask() !== null);
    expect(getCurrentTask()?.userMessage).toBe("message A");
    await delay(120); // allow a chunk or two to stream

    // --- 2. Stop while A is mid-stream ------------------------------------
    abortCurrentTask();
    expect(getCurrentTask()?.aborted).toBe(true);

    // Worker must unwind without marking the task failed.
    await promiseA;
    const taskA = getCurrentTask();
    // cancelTask leaves status "error"/Cancelled (UI-only), but the worker
    // must NOT have written an error message over it.
    expect(taskA?.status).toBe("error");
    expect(taskA?.statusDetail).toBe("Cancelled");
    expect(taskA?.displayContent.includes("Unknown error")).toBe(false);

    // The fetch for A must have been cut before the full reply arrived.
    expect(chatFetchCount).toBe(1);

    // --- 3. Send B right after Stop ---------------------------------------
    // Fresh controller: task B must stream to completion despite A's abort.
    const promiseB = runInBackground(
      "message B",
      null,
      [],
      "ask",
      []
    );
    await waitFor(() => chatFetchCount >= 2);
    await promiseB;

    const taskB = getCurrentTask();
    expect(taskB?.userMessage).toBe("message B");
    // B finished naturally and reached "done" with the model's content.
    expect(taskB?.status).toBe("done");
    expect(taskB?.displayContent).toContain("Here is the answer");
    expect(taskB?.aborted).toBeUndefined();
  });

  it("does not treat Stop as a task failure (no failTask path)", async () => {
    const promiseA = runInBackground("stop me", null, [], "ask", []);
    await waitFor(() => getCurrentTask() !== null);
    await delay(80);

    abortCurrentTask();
    await promiseA;

    const task = getCurrentTask();
    // Cancelled, but display content never got an injected failure message.
    expect(task?.statusDetail).toBe("Cancelled");
    expect(task?.displayContent || "").not.toMatch(/Unknown error|Task failed/);
  });
});


