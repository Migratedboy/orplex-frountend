/**
 * orchestration-wiring.test.ts — Verifies the strategy router is actually
 * wired into the code-mode agent loop:
 *
 *  1. A routed plan (auto op via /api/agent/orchestrate) writes files before
 *     the main loop, which then reviews/refines; auto-verification passes.
 *  2. The structured review lane with negative consensus feeds one model
 *     repair turn.
 *  3. Semantic cache: a past similar task is offered as context (hint only).
 */
import { runInBackground, setFileSystemAccess } from "../background-worker";
import { getCurrentTask, abortCurrentTask } from "../background-chat";
import { cacheResponse } from "../semantic-cache";
import { waitFor } from "./helpers";

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

const ORIGINAL_FETCH = global.fetch;
const CLEAN_WRITE = 'export const tag = "routed";\n';
const store: Record<string, string> = {};
let chatFetchCount = 0;
let execCount = 0;
let orchestrateCalls: string[] = [];

beforeEach(() => {
  chatFetchCount = 0;
  execCount = 0;
  orchestrateCalls = [];
  for (const k of Object.keys(store)) delete store[k];

  setFileSystemAccess(
    async (p) => (p in store ? store[p] : "[Error: file not found]"),
    async (p, content) => {
      store[p] = content;
      return true;
    },
    async (p, oldText, newText) => {
      if (!(p in store) || !store[p].includes(oldText)) return false;
      store[p] = store[p].replace(oldText, newText);
      return true;
    },
    [],
    {},
    "test-workspace"
  );
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  try {
    if (getCurrentTask()) abortCurrentTask();
  } catch {}
});

describe("orchestration wiring (code mode)", () => {
  it("runs SPARC planning, writes the planned files, then verifies", async () => {
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/chat")) {
        chatFetchCount++;
        const n = chatFetchCount;
        if (n === 1) {
          // SPARC already wrote the file; the loop reviews it (read_file),
          // then gives a text-only answer to end the loop.
          return streamOnce([
            toolCallChunk({ name: "read_file", path: "sparc-out.ts" }),
            doneChunk(),
          ]);
        }
        if (n === 2) {
          return streamOnce([textChunk("Looks good."), doneChunk()]);
        }
        // Mandatory self-reflection confirm.
        return streamOnce([textChunk("Re-checked — clean."), doneChunk()]);
      }
      if (url.includes("/api/agent/orchestrate")) {
        const body = JSON.parse(String(init?.body));
        orchestrateCalls.push(body.op);
        return new Response(
          JSON.stringify({
            ok: true,
            strategy: "scaffold",
            status: "completed",
            summary: "Goal: dashboard — 3 files planned.",
            toolCalls: [{ name: "write_file", path: "sparc-out.ts", content: CLEAN_WRITE }],
            files: ["sparc-out.ts"],
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/agent/exec")) {
        execCount++;
        return new Response(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }), { status: 200 });
      }
      if (url.includes("/api/agent/approve")) {
        return new Response(JSON.stringify({ approved: true }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    // Complex-task phrasing triggers the SPARC-plan-first gate → orchestration.
    const promise = runInBackground(
      "build a complete dashboard application with full features",
      null,
      [],
      "code",
      []
    );
    await waitFor(() => getCurrentTask() !== null);
    await promise;

    const task = getCurrentTask();
    expect(task?.status).toBe("done");
    expect(orchestrateCalls).toContain("auto");
    expect(store["sparc-out.ts"]).toBe(CLEAN_WRITE);

    const display = task?.displayContent || "";
    expect(display).toMatch(/\[SCAFFOLD\]/);
    expect(display).toMatch(/typecheck clean|Verification passed/);
  });

  it("feeds swarm review findings into a repair turn when consensus fails", async () => {
    const REWRITE = 'export const tag = "swarm-fixed";\n';
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/chat")) {
        chatFetchCount++;
        const n = chatFetchCount;
        if (n === 1) {
          return streamOnce([
            toolCallChunk({ name: "write_file", path: "swarm-file.ts", content: 'export const tag = "draft";\n' }),
            doneChunk(),
          ]);
        }
        if (n === 2) {
          return streamOnce([textChunk("Written."), doneChunk()]);
        }
        if (n === 3) {
          // Self-reflection confirm (text only, no issues).
          return streamOnce([textChunk("Re-checked — clean."), doneChunk()]);
        }
        if (n === 4) {
          // Swarm-repair turn: model rewrites the flagged file.
          return streamOnce([
            toolCallChunk({ name: "write_file", path: "swarm-file.ts", content: REWRITE }),
            doneChunk(),
          ]);
        }
        return streamOnce([textChunk("ok"), doneChunk()]);
      }
      if (url.includes("/api/agent/orchestrate")) {
        const body = JSON.parse(String(init?.body));
        orchestrateCalls.push(body.op);
        if (body.op === "review") {
          return new Response(
            JSON.stringify({
              ok: true,
              consensus: false,
              findings: [{ severity: "critical", description: "missing error handling" }],
              review: '[{"severity":"critical","description":"missing error handling"}]',
              tests: "",
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/api/agent/exec")) {
        execCount++;
        return new Response(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }), { status: 200 });
      }
      if (url.includes("/api/agent/approve")) {
        return new Response(JSON.stringify({ approved: true }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const promise = runInBackground("write a tiny module", null, [], "code", []);
    await waitFor(() => getCurrentTask() !== null);
    await promise;

    const task = getCurrentTask();
    expect(task?.status).toBe("done");
    expect(orchestrateCalls).toContain("review");
    expect(store["swarm-file.ts"]).toBe(REWRITE);

    const display = task?.displayContent || "";
    expect(display).toMatch(/Code review/);
    expect(display).toMatch(/repairing/i);
  });

  it("offers a cached prior task as reference context (hint only)", async () => {
    // Seed the cache with a strong match for the incoming message.
    cacheResponse(
      "fix the login authentication flow and resolve the auth issue",
      "PAST RESULT: patched src/auth.ts and it worked.",
      ["src/auth.ts"]
    );

    let sawCacheContext = false;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/chat")) {
        chatFetchCount++;
        const body = JSON.parse(String(init?.body));
        const lastMsg = body.messages?.[body.messages.length - 1]?.content || "";
        if (lastMsg.includes("[CACHED CONTEXT]")) sawCacheContext = true;
        if (chatFetchCount === 1) {
          return streamOnce([textChunk("Done."), doneChunk()]);
        }
        return streamOnce([textChunk("ok"), doneChunk()]);
      }
      if (url.includes("/api/agent/exec")) {
        execCount++;
        return new Response(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const promise = runInBackground(
      "fix the login authentication flow and resolve the auth issue",
      null,
      [],
      "code",
      []
    );
    await waitFor(() => getCurrentTask() !== null);
    await promise;

    const task = getCurrentTask();
    expect(task?.status).toBe("done");
    expect(sawCacheContext).toBe(true);
    // Nothing was written (text-only reply), so no self-review/recheck turns follow.
    expect(chatFetchCount).toBe(1);
  });
});
