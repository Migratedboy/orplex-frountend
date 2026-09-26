/**
 * live-run2-hardening.test.ts — Regression coverage for the defects the SECOND
 * live dashboard run exposed:
 *
 *  1. Task amnesia: fitMessagesToBudget drops OLDEST messages first, so on a
 *     long tool loop the original task fell out of context and the model asked
 *     "What would you like me to help you with?" mid-build. appendTaskAnchor
 *     pins the task onto the last message — the one trimming never drops.
 *  2. Interleaved replay: gpt-oss emitted a replayed token mix into thinking
 *     ("The user has The user has provided tool provided tool results").
 *     repairInterleavedReplay merges copy+overlap spans at word offsets while
 *     leaving clean text untouched.
 *  3. Sandbox serve bypass: the model routed `npx serve` through
 *     run_in_sandbox, which fell through to blocking exec against Orplex's own
 *     port. The sandbox lane now detects server commands and uses the detached
 *     serve route.
 */
import { appendTaskAnchor, repairInterleavedReplay } from "../stream-reader";
import { fitMessagesToBudget } from "../background-worker";
import { runInBackground, setFileSystemAccess } from "../background-worker";
import { getCurrentTask, abortCurrentTask } from "../background-chat";
import { waitFor } from "./helpers";

// ============================================================
// 1. Task anchor
// ============================================================

describe("appendTaskAnchor — task survives context trimming", () => {
  it("pins the task onto the last message", () => {
    const msgs = [
      { role: "user", content: "build a dashboard" },
      { role: "assistant", content: "working on it" },
      { role: "user", content: "[TOOL RESULTS] ..." },
    ];
    const out = appendTaskAnchor(msgs, "build a dashboard with hero and pricing");
    expect(out[out.length - 1].content).toContain("[ORIGINAL TASK");
    expect(out[out.length - 1].content).toContain("build a dashboard with hero and pricing");
    // Earlier messages untouched
    expect(out[0].content).toBe("build a dashboard");
  });

  it("is idempotent — no double anchor on repeated calls", () => {
    const msgs = [{ role: "user", content: "task" }];
    const once = appendTaskAnchor(msgs, "the task");
    const twice = appendTaskAnchor(once, "the task");
    expect(twice[twice.length - 1].content.match(/\[ORIGINAL TASK/g)).toHaveLength(1);
  });

  it("is a no-op without a task or messages", () => {
    const msgs = [{ role: "user", content: "x" }];
    expect(appendTaskAnchor(msgs, "")).toBe(msgs);
    expect(appendTaskAnchor([], "task")).toEqual([]);
  });

  it("the anchored last message survives an aggressive fitMessagesToBudget", () => {
    // The exact live failure: oldest-first dropping evicted message[0].
    const msgs = [
      { role: "user", content: "create an index.html file with a hero section and pricing table" },
      { role: "assistant", content: "tool call 1 ".repeat(400) },
      { role: "assistant", content: "tool call 2 ".repeat(400) },
      { role: "user", content: "[TOOL RESULTS]\nfile written" },
    ];
    const anchored = appendTaskAnchor(msgs, "create an index.html file with a hero section and pricing table");
    const fitted = fitMessagesToBudget(anchored, 200); // tiny budget
    const all = fitted.map((m) => m.content).join("\n");
    expect(all).toContain("[ORIGINAL TASK");
    expect(all).toContain("create an index.html file with a hero section and pricing table");
  });
});

// ============================================================
// 2. Interleaved replay repair
// ============================================================

describe("repairInterleavedReplay — gpt-oss replay mix", () => {
  it("repairs the exact live corrupted thinking block", () => {
    const corrupted =
      "II need to understand the need to understand the task.. The user has The user has provided tool provided tool results showing:\n results showing:\n1. A failed1. A failed `npx serve `npx serve`` command (port command (port 50 5000)\n200)";
    const out = repairInterleavedReplay(corrupted);
    expect(out).toContain("The user has provided tool results showing");
    expect(out).not.toContain("The user has The user has");
    expect(out).not.toContain("provided tool provided tool");
  });

  it("collapses the copy+overlap double pattern cleanly", () => {
    const out = repairInterleavedReplay("We should check the We should check the file contents first");
    expect(out).toBe("We should check the file contents first");
  });

  it("leaves clean thinking untouched", () => {
    const clean =
      "The workspace has index.html and package.json. The serve command failed, possibly because the port is in use. Since there's no explicit task, I should continue building.";
    expect(repairInterleavedReplay(clean)).toBe(clean);
  });

  it("is idempotent", () => {
    const corrupted = "The user has The user has provided tool provided tool results showing the files";
    expect(repairInterleavedReplay(repairInterleavedReplay(corrupted))).toBe(repairInterleavedReplay(corrupted));
  });

  it("repairs letter-seam corruption from live run 3 (pythonpython33)", () => {
    // Copies glued directly at a letter seam — the most common gpt-oss shape.
    // Deliberate residue: sub-token doubles ("python33" tail, "- -mm" from
    // unit-1 "-m/-m") are left — a 1-char/sub-token double is indistinguishable
    // from legitimate text ("port 33", "hello", "aardvark") without semantics.
    const corrupted = "can run perhaps pythonpython33 - -mm http.server.server 55000000";
    const out = repairInterleavedReplay(corrupted);
    expect(out).not.toContain("pythonpython");
    expect(out).not.toContain("server.server");
    expect(out).toContain("http.server 5500");
  });

  it("repairs verify _app_app glued token doubles", () => {
    // "_app_app" is a whole-token double (unit "app", underscore boundaries)
    // — safe to repair. Sub-token prefix doubles ("rereereadad") are residue:
    // a word-internal repeat ("aardvark") must never be eaten.
    const corrupted = "Need use verify _app_app likely path. Should not rereereadad the file.";
    const out = repairInterleavedReplay(corrupted);
    expect(out).toContain("verify _app");
    expect(out).not.toContain("_app_app");
  });

  it("repairs run-6 line-boundary echo shapes (with:\n     with:)", () => {
    // Copies separated by newline + indentation — the run-6 live shape.
    const corrupted = "create an index.html file with:\n     with:\n1. A working hero section";
    const out = repairInterleavedReplay(corrupted);
    expect(out).toContain("file with:\n1. A working hero");
    expect(out).not.toContain("with:\n     with:");
  });

  it("repairs punct+space echo seams (grid. A features grid)", () => {
    const corrupted = "2 . A features grid. A features grid\n3. A pricing table";
    const out = repairInterleavedReplay(corrupted);
    expect(out).toContain("A features grid.\n3. A pricing");
    expect(out).not.toContain("grid. A features grid");
  });

  it("never eats markdown seams — (browser verification)**Browser verification passed", () => {
    // The live-run-3 false positive: adjacent repetition separated by a
    // punctuation seam is legitimate prose, not replay corruption.
    const legit =
      "[SUCCESS] Fixed `index.html` (browser verification)\n**Browser verification passed ✓** (screenshot: shot.png) — no console errors";
    expect(repairInterleavedReplay(legit)).toBe(legit);
  });
});

// ============================================================
// 3. run_in_sandbox server lane
// ============================================================

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

describe("run_in_sandbox — server commands route to the detached serve lane", () => {
  const originalFetch = global.fetch;
  let serveCalls = 0;
  let execCalls = 0;

  beforeEach(() => {
    serveCalls = 0;
    execCalls = 0;
    let chatCount = 0;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/chat")) {
        chatCount++;
        if (chatCount === 1) {
          return Promise.resolve(
            streamOnce([toolCallChunk({ name: "run_in_sandbox", command: "npx serve . -l 3002" }), doneChunk()])
          );
        }
        return Promise.resolve(streamOnce([textChunk("**Served.** The app is live."), doneChunk()]));
      }
      if (url.includes("/api/agent/serve")) {
        serveCalls++;
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, message: "listening", port: 3002, output: "" }), { status: 200 })
        );
      }
      if (url.includes("/api/agent/exec")) {
        execCalls++;
        return Promise.resolve(new Response(JSON.stringify({ exitCode: 0, stdout: "", stderr: "" }), { status: 200 }));
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

  it("uses /api/agent/serve — never blocking exec — for server commands", async () => {
    const { approveRequestAlways, getPendingApprovals } = await import("../approval-store");
    const timer = setInterval(() => {
      for (const p of getPendingApprovals()) approveRequestAlways(p.id);
    }, 500);

    try {
      const promise = runInBackground("serve the app", null, [], "code", []);
      await waitFor(() => getCurrentTask() !== null);
      await promise;
      const task = getCurrentTask();

      expect(serveCalls).toBe(1);
      expect(execCalls).toBe(0); // pre-fix: exec burned the timeout on the live port
      expect(task?.status).toBe("done");
      expect(task?.displayContent).toContain("Server running");
    } finally {
      clearInterval(timer);
    }
  });
});
