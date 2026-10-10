/**
 * self-review.test.ts — Wires-up test for the CODE-mode self-review pass.
 *
 * Drives the REAL background worker against a scripted mock /api/chat:
 *   call 1: model writes an insecure file (direct innerHTML assignment)
 *   call 2: model answers text-only (loop ends)
 *   → post-loop quickQualityCheck must find a critical issue and issue a
 *     [QUALITY REVIEW] repair request
 *   call 3: model returns the fixed file
 *   → fix is executed and the transcript reports "Self-review passed"
 */
import { runInBackground, setFileSystemAccess } from "../background-worker";
import { getCurrentTask, abortCurrentTask } from "../background-chat";
import { waitFor } from "./helpers";

const INSECURE_CONTENT =
  "export function renderHtml(el: HTMLElement, html: string): void {\n  el.innerHTML = html;\n}\n";
const SECURE_CONTENT =
  "export function renderHtml(el: HTMLElement, html: string): void {\n  el.textContent = html;\n}\n";

const toolCallChunk = (call: object) =>
  `data: ${JSON.stringify({ content: `<tool_call>${JSON.stringify(call)}</tool_call>` })}\n\n`;
const textChunk = (text: string) =>
  `data: ${JSON.stringify({ content: text })}\n\n`;
const doneChunk = () => "data: [DONE]\n\n";

function streamOnce(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("CODE-mode self-review pass", () => {
  const originalFetch = global.fetch;
  let chatFetchCount: number;
  let chatBodies: any[];

  beforeEach(() => {
    chatFetchCount = 0;
    chatBodies = [];
    // The no-workspace guard refuses writes without registered FS access —
    // these worker tests simulate an open folder with stub file ops.
    setFileSystemAccess(
      async () => "[Error: not found]",
      async () => true,
      async () => false,
      [],
      {},
      "test-workspace"
    );
    global.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/chat")) {
        chatFetchCount++;
        chatBodies.push(JSON.parse(String(init?.body)));
        const n = chatFetchCount;
        if (n === 1) {
          return Promise.resolve(
            streamOnce([
              toolCallChunk({
                name: "write_file",
                path: "self-review-dom.ts",
                content: INSECURE_CONTENT,
              }),
              doneChunk(),
            ])
          );
        }
        if (n === 2) {
          return Promise.resolve(
            streamOnce([textChunk("Created the file."), doneChunk()])
          );
        }
        if (n === 3) {
          // Self-repair turn: rewrite the file without the security issue.
          return Promise.resolve(
            streamOnce([
              toolCallChunk({
                name: "write_file",
                path: "self-review-dom.ts",
                content: SECURE_CONTENT,
              }),
              doneChunk(),
            ])
          );
        }
        if (n === 4) {
          // Post-repair self-reflection: model confirms the files are clean.
          return Promise.resolve(
            streamOnce([textChunk("Re-checked the files — no further issues."), doneChunk()])
          );
        }
        return Promise.resolve(streamOnce([textChunk("ok"), doneChunk()]));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    try {
      if (getCurrentTask()) abortCurrentTask();
    } catch {}
  });

  it("detects critical issues, requests repairs, and reports the outcome", async () => {
    const promise = runInBackground(
      "write a small dom helper file",
      null,
      [],
      "code",
      []
    );
    await waitFor(() => getCurrentTask() !== null);
    await promise;

    const task = getCurrentTask();
    expect(task?.status).toBe("done");

    // Calls 1 & 2 are the main loop; call 3 is the self-review repair turn;
    // call 4 is the mandatory post-repair self-reflection.
    expect(chatFetchCount).toBe(4);
    const reviewBody = chatBodies[2];
    const reviewUserMsg = [...reviewBody.messages]
      .reverse()
      .find((m: any) => m.role === "user");
    expect(reviewUserMsg?.content).toContain("[QUALITY REVIEW]");
    expect(reviewUserMsg?.content).toContain("innerHTML");

    // The fix was executed and the transcript shows the review outcome.
    const display = task?.displayContent || "";
    expect(display).toMatch(/Self-review:/);
    expect(display).toMatch(/Self-review passed/);
    expect(display).toContain("Fixed `self-review-dom.ts`");
  });
});
