/**
 * live-run-hardening.test.ts — Regression coverage for the defects the first
 * LIVE dashboard run exposed, plus the prompt-hardening guards:
 *
 *  1. Echoed thinking: some providers deliver reasoning on BOTH the thinking
 *     channel AND verbatim at the head of `content` → the transcript showed
 *     every deliberation paragraph twice. stripEchoedThinking must cut the
 *     echo while leaving unrelated answers untouched.
 *  2. FORCE TOOLS false positive: a text-only turn AFTER successful writes is
 *     a final summary — "You described the plan but created no files" must
 *     never fire once real files exist.
 *  3. verify_app infrastructure failures: a crashed harness (no package.json
 *     in the workspace → npm walks up to Orplex itself, Turbopack corruption,
 *     Playwright missing) must reach the model as "not about your app" —
 *     never as a pass/fail verdict on the agent's code.
 *  4. stripRedundantFences: full-file fences in the final answer are replaced
 *     with a pointer when the task already wrote the real files (Prime
 *     Directive #1), while small snippets and thinking blocks survive.
 */
import { runInBackground, setFileSystemAccess } from "../background-worker";
import { getCurrentTask, abortCurrentTask } from "../background-chat";
import { stripEchoedThinking, stripRedundantFences } from "../stream-reader";
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

// ============================================================
// 1. Echoed thinking
// ============================================================

describe("stripEchoedThinking", () => {
  const deliberation =
    "We need to create index.html with inline CSS and JS. Workspace is empty. We'll create hero, features grid, pricing table, mobile nav toggle.";

  it("cuts the echoed prefix and keeps the real answer", () => {
    const content = deliberation + "\n\n**Created `index.html`** — hero, features grid, pricing.";
    const out = stripEchoedThinking(content, deliberation);
    expect(out).toBe("\n\n**Created `index.html`** — hero, features grid, pricing.");
    expect(out).not.toContain("Workspace is empty");
  });

  it("strips even when punctuation/spacing differs between channels", () => {
    const content = "We need to create index.html,  with inline CSS!!!\n\nAnswer: done.";
    const out = stripEchoedThinking(content, "We need to create index html with inline css");
    expect(out).toContain("Answer: done.");
    expect(out).not.toContain("We need to create");
  });

  it("leaves ordinary answers untouched (no echo)", () => {
    const content = "# Dashboard\nAll checks passed.";
    expect(stripEchoedThinking(content, "unrelated deliberation text that shares nothing")).toBe(content);
  });

  it("is a no-op without thinking or with tiny content", () => {
    expect(stripEchoedThinking("short", "some thinking")).toBe("short");
    expect(stripEchoedThinking("answer text", "")).toBe("answer text");
  });
});

// ============================================================
// 4. FILES-NOT-FENCES display guard
// ============================================================

describe("stripRedundantFences", () => {
  const bigFence = "```html\n" + Array.from({ length: 10 }, (_, i) => `<div>${i}</div>`).join("\n") + "\n```";

  it("replaces full-file fences with a pointer when files were written", () => {
    const out = stripRedundantFences(`Done.\n\n${bigFence}\n\nVerified.`, { filesWritten: true });
    expect(out).toContain("already written to the workspace");
    expect(out).not.toContain("<div>5</div>");
    expect(out).toContain("Done.");
    expect(out).toContain("Verified.");
  });

  it("keeps small snippets (≤6 lines) even when files were written", () => {
    const snippet = "```js\nconst a = 1;\nconst b = 2;\n```";
    expect(stripRedundantFences(snippet, { filesWritten: true })).toBe(snippet);
  });

  it("never touches reasoning inside [THINKING] blocks", () => {
    const text = `[THINKING]\nPlan:\n${bigFence}\n[/THINKING]\n\nAnswer.`;
    const out = stripRedundantFences(text, { filesWritten: true });
    expect(out).toContain(bigFence);
  });

  it("is a no-op when nothing was written this task", () => {
    expect(stripRedundantFences(bigFence, { filesWritten: false })).toBe(bigFence);
  });
});

// ============================================================
// 2. FORCE TOOLS false positive (wiring)
// ============================================================

describe("FORCE TOOLS gate — writes before the text-only turn", () => {
  const originalFetch = global.fetch;
  let chatCount = 0;
  let chatBodies: any[] = [];

  beforeEach(() => {
    chatCount = 0;
    chatBodies = [];
    global.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/chat")) {
        chatCount++;
        chatBodies.push(JSON.parse(String(init?.body)));
        if (chatCount === 1) {
          return Promise.resolve(
            streamOnce([
              toolCallChunk({ name: "write_file", path: "util.ts", content: "export const answer = 42;\n" }),
              doneChunk(),
            ])
          );
        }
        // Final summary — text only. Pre-fix this triggered [FORCE TOOLS].
        return Promise.resolve(
          streamOnce([textChunk("**Created `util.ts`** — exports the answer constant."), doneChunk()])
        );
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

  it("treats the post-write summary as the final answer — no [FORCE TOOLS] nudge", async () => {
    const promise = runInBackground("create a util file", null, [], "code", []);
    await waitFor(() => getCurrentTask() !== null);
    await promise;

    const task = getCurrentTask();
    expect(task?.status).toBe("done");
    // write turn + summary turn + mandatory self-review reflection (a designed
    // platform lane, not a hijack). What matters: NO [FORCE TOOLS] nudge and
    // the task still reports done — the summary was treated as the final answer.
    expect(chatCount).toBe(3);
    expect(JSON.stringify(chatBodies)).not.toContain("[FORCE TOOLS]");
    expect(task?.displayContent).toContain("Created `util.ts`");
  });
});

// ============================================================
// 3. verify_app infrastructure failure (wiring)
// ============================================================

describe("verify_app — infrastructure failure classification", () => {
  const originalFetch = global.fetch;
  let chatCount = 0;
  let chatBodies: any[] = [];

  beforeEach(() => {
    chatCount = 0;
    chatBodies = [];
    setFileSystemAccess(
      async (p) => (p === "package.json" ? "{\"name\":\"x\"}" : "[Error: not found]"),
      async () => true,
      async () => false,
      [],
      {},
      "static-site-workspace"
    );
    global.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/chat")) {
        chatCount++;
        chatBodies.push(JSON.parse(String(init?.body)));
        if (chatCount === 1) {
          return Promise.resolve(
            streamOnce([toolCallChunk({ name: "verify_app", path: "/", port: 4321 }), doneChunk()])
          );
        }
        return Promise.resolve(streamOnce([textChunk("Harness failed — reported honestly."), doneChunk()]));
      }
      if (url.includes("/api/agent/verify")) {
        // The harness refused before rendering (workspace-boundary guard).
        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              runId: "ad-hoc",
              result: {
                success: false,
                error:
                  "infrastructure-failure: the workspace has no package.json, so `npm run dev` would run from the NEAREST parent package.json (possibly the Orplex app itself) instead of your project.",
                consoleErrors: [],
                consoleWarnings: [],
                durationMs: 4,
                timeline: [],
                artifacts: [],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
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

  it("tells the model the harness failed — never a verdict on its app", async () => {
    const promise = runInBackground("verify the site", null, [], "code", []);
    await waitFor(() => getCurrentTask() !== null);
    await promise;

    const task = getCurrentTask();
    expect(task?.status).toBe("done");

    // The tool result pushed back to the model classifies the failure.
    const followUp = JSON.stringify(chatBodies[1]);
    expect(followUp).toContain("infrastructure-failure");
    expect(followUp).toContain("NOTHING about your app");

    // The transcript shows a harness warning, not an app verdict.
    const display = task?.displayContent || "";
    expect(display).toContain("harness failed");
    expect(display).not.toContain("[FAIL] Verification failed: infrastructure-failure");
  });
});
