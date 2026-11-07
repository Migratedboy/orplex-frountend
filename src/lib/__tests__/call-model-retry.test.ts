/**
 * call-model-retry.test.ts — LIVE-VALIDATED (run 4): a single transient
 * provider blip ("fetch failed") on call #2 killed an otherwise-healthy
 * dashboard task after it had already produced its plan. The main loop must
 * retry such blips once — and NEVER retry aborts or permanent failures.
 */
import { runInBackground, setFileSystemAccess } from "../background-worker";
import { getCurrentTask, abortCurrentTask } from "../background-chat";
import { onAgentStatus } from "../agent-events";
import { waitFor } from "./helpers";

const toolCallChunk = (call: object) =>
  `data: ${JSON.stringify({ content: `<tool_call>${JSON.stringify(call)}</tool_call>` })}\n\n`;
const textChunk = (text: string) => `data: ${JSON.stringify({ content: text })}\n\n`;
const doneChunk = () => "data: [DONE]\n\n";

function streamOnce(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_FS = (globalThis as any).__orplexFs;

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  (globalThis as any).__orplexFs = ORIGINAL_FS;
  try {
    if (getCurrentTask()) abortCurrentTask();
  } catch {}
});

describe("callModel transient-blip retry", () => {
  it("recovers the task when the provider connection drops once mid-task", async () => {
    let chatCount = 0;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/chat")) {
        chatCount++;
        if (chatCount === 1) {
          return streamOnce([toolCallChunk({ name: "write_file", path: "a.ts", content: "export const a = 1;\n" }), doneChunk()]);
        }
        if (chatCount === 2) throw new TypeError("fetch failed"); // the live-run-4 blip
        return streamOnce([textChunk("Recovered and done."), doneChunk()]);
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const promise = runInBackground("write a file", null, [], "code", []);
    await waitFor(() => getCurrentTask() !== null);
    await promise;

    const task = getCurrentTask();
    expect(task?.status).toBe("done");
    expect(chatCount).toBeGreaterThanOrEqual(3); // write turn + blip + retried turn
    expect(task?.displayContent).toContain("Recovered and done.");
  });

  it("does not retry permanent failures — the task fails immediately", async () => {
    let chatCount = 0;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/chat")) {
        chatCount++;
        if (chatCount === 1) throw new Error("401 Unauthorized: bad key");
        return streamOnce([textChunk("should never get here"), doneChunk()]);
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const promise = runInBackground("write a file", null, [], "code", []);
    await waitFor(() => getCurrentTask() !== null);
    await promise.catch(() => undefined);

    await waitFor(() => getCurrentTask()?.status === "error", 8000);
    expect(chatCount).toBe(1); // exactly one attempt — no retry on 401
  });

  it("climbs past the old one-retry cap and shows [attempt N/20] in the feed", async () => {
    // The old code tolerated exactly ONE blip (2 attempts). This blips TWICE
    // and must still recover — proving the ladder is longer — and each retry
    // must reach the UI as its own `[attempt N/20]` row.
    const seen: string[] = [];
    const off = onAgentStatus((evt) => {
      if (evt.type === "activity") seen.push(evt.entry.message);
    });
    let chatCount = 0;
    let blips = 0;
    global.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/chat")) {
        chatCount++;
        if (chatCount <= 2) {
          blips++;
          throw new TypeError("fetch failed");
        }
        return streamOnce([textChunk("Recovered on attempt 3."), doneChunk()]);
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const promise = runInBackground("write a file", null, [], "code", []);
    await waitFor(() => getCurrentTask() !== null);
    await promise;
    off();

    const task = getCurrentTask();
    // Two blips survived, so the ladder climbed past the old one-retry cap.
    // (chatCount is >= 3 rather than exactly 3 because the worker may issue a
    // follow-up turn after a tool-less reply; the blips are what matter.)
    expect(blips).toBe(2);
    expect(chatCount).toBeGreaterThanOrEqual(3);
    expect(task?.status).toBe("done");
    expect(seen.some((m) => m.startsWith("[attempt 1/20]"))).toBe(true);
    expect(seen.some((m) => m.startsWith("[attempt 2/20]"))).toBe(true);
  });

  it("never retries after the user aborts", async () => {
    let chatCount = 0;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/chat")) {
        chatCount++;
        if (chatCount === 1) {
          abortCurrentTask();
          throw new TypeError("fetch failed");
        }
        return streamOnce([textChunk("should never get here"), doneChunk()]);
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const promise = runInBackground("write a file", null, [], "code", []);
    await waitFor(() => getCurrentTask() !== null);
    await promise.catch(() => undefined);

    expect(chatCount).toBe(1); // abort must win — no auto-resume
  });
});
