/**
 * sparc-gate.test.ts — Plan-first gate on complex CODE tasks.
 *
 * Complex tasks get the [SPARC] directive, and write tools are BLOCKED
 * until the model has planned (todo_list) or inspected the workspace
 * (read_file/list_files/search_code). Verifies:
 *   1. The first user message carries the [SPARC] directive.
 *   2. A write_file before any planning is blocked with a gate message.
 *   3. After todo_list, the write goes through.
 */
import { runInBackground, setFileSystemAccess } from "../background-worker";
import { getCurrentTask, abortCurrentTask } from "../background-chat";
import { waitFor } from "./helpers";

const FILE_CONTENT = "export const x = 1;\n";

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

// Prompt with >= 5 multi-sentence requirements so isComplexTask() fires
// (hasMultipleRequirements: split on newlines/periods, > 10 chars each).
const COMPLEX_REQUEST = [
  "Build a full dashboard.",
  "It needs a chart view with filters and a summary panel with totals.",
  "Add a settings page where users can change theme and notification preferences.",
  "Include an activity feed listing recent events across the whole workspace.",
  "Persist user preferences in localStorage and sync them with the server api.",
  "Write components, types, and utilities for this application.",
].join(" ");

describe("SPARC plan-first gate (complex CODE tasks)", () => {
  const originalFetch = global.fetch;
  let chatFetchCount: number;
  let chatBodies: any[];

  beforeEach(() => {
    chatFetchCount = 0;
    chatBodies = [];
    // The no-workspace guard refuses writes without registered FS access —
    // this worker test simulates an open folder with stub file ops.
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
          // Model tries to write BEFORE planning — must be blocked.
          return Promise.resolve(
            streamOnce([
              toolCallChunk({
                name: "write_file",
                path: "sparc-gate.ts",
                content: FILE_CONTENT,
              }),
              doneChunk(),
            ])
          );
        }
        if (n === 2) {
          // Model plans, then writes — write must now pass the gate.
          return Promise.resolve(
            streamOnce([
              toolCallChunk({ name: "todo_list", todo: ["plan first", "then write"] }),
              toolCallChunk({
                name: "write_file",
                path: "sparc-gate.ts",
                content: FILE_CONTENT,
              }),
              doneChunk(),
            ])
          );
        }
        return Promise.resolve(streamOnce([textChunk("Done."), doneChunk()]));
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

  it("directives complex tasks and blocks writes until planning happened", async () => {
    const promise = runInBackground(COMPLEX_REQUEST, null, [], "code", []);
    await waitFor(() => getCurrentTask() !== null);
    await promise;

    const task = getCurrentTask();
    expect(task?.status).toBe("done");

    // 1. The [SPARC] directive was prepended to the user request.
    const firstUserMsg = chatBodies[0].messages.find(
      (m: any) => m.role === "user"
    );
    expect(firstUserMsg?.content).toContain("[SPARC]");

    // 2. The unplanned write was blocked with the gate message…
    expect(chatFetchCount).toBeGreaterThanOrEqual(2);
    const toolResultsMsg = chatBodies[1].messages.find((m: any) =>
      m.content?.includes("[TOOL RESULTS]")
    );
    expect(toolResultsMsg?.content).toContain("BLOCKED by plan-first gate");

    // 3. …and after todo_list, the write succeeded.
    const display = task?.displayContent || "";
    expect(display).toMatch(/Wrote `sparc-gate\.ts`|writing \[sparc-gate\.ts\]/);
  });
});
