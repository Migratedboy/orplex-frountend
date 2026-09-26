/**
 * auto-verification.test.ts — Closed-loop autonomy tests.
 *
 * Unit: summarizeTypecheckOutput + buildVerificationRepairPrompt.
 * Integration: drives the REAL background worker against a scripted mock
 * /api/chat + /api/agent/exec:
 *   chat 1: model writes calc.ts (clean, no self-review issues)
 *   chat 2: text-only → main loop ends
 *   chat 3: mandatory self-reflection confirms the files are clean
 *   exec 1: `npx tsc --noEmit` FAILS with error TS2345 in calc.ts
 *   chat 4: verification repair turn → model edits calc.ts
 *   exec 2: typecheck PASSES → "Verification passed"
 */
import {
  runInBackground,
  setFileSystemAccess,
  summarizeTypecheckOutput,
  buildVerificationRepairPrompt,
} from "../background-worker";
import { getCurrentTask, abortCurrentTask } from "../background-chat";
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

describe("summarizeTypecheckOutput", () => {
  it("extracts deduped error TS lines", () => {
    const raw = [
      "src/a.ts(3,5): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.",
      "some unrelated noise",
      "src/a.ts(3,5): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.",
      "src/b.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
    ].join("\n");
    const out = summarizeTypecheckOutput(raw);
    expect(out.split("\n")).toHaveLength(2);
    expect(out).toContain("error TS2345");
    expect(out).toContain("error TS2322");
    expect(out).not.toContain("unrelated noise");
  });

  it("caps the number of reported errors", () => {
    const raw = Array.from({ length: 20 }, (_, i) => `f${i}.ts(1,1): error TS2304: Cannot find name 'x${i}'.`).join("\n");
    expect(summarizeTypecheckOutput(raw).split("\n")).toHaveLength(8);
  });

  it("returns empty string for clean output", () => {
    expect(summarizeTypecheckOutput("")).toBe("");
    expect(summarizeTypecheckOutput("All good, exit 0")).toBe("");
  });

  it("ignores no-tsconfig projects (TS18003) — nothing to typecheck", () => {
    expect(
      summarizeTypecheckOutput("error TS18003: No inputs were found in config file")
    ).toBe("");
  });
});

describe("buildVerificationRepairPrompt", () => {
  it("includes the findings, the task's files, and the fix instruction", () => {
    const prompt = buildVerificationRepairPrompt("src/a.ts(1,1): error TS2304: boom", [
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(prompt).toContain("[VERIFICATION FAILED]");
    expect(prompt).toContain("error TS2304");
    expect(prompt).toContain("src/a.ts, src/b.ts");
    expect(prompt).toContain("edit_file");
  });
});

describe("closed-loop auto-verification (code mode)", () => {
  const originalFetch = global.fetch;
  const store: Record<string, string> = {};
  const CLEAN = 'export function greet(name: string): string {\n  return "Hello " + name;\n}\n';
  const OLD = 'return "Hello " + name;';
  const NEW = "return `Hello ${name}`;";
  let chatFetchCount = 0;
  let execCount = 0;

  beforeEach(() => {
    chatFetchCount = 0;
    execCount = 0;
    for (const k of Object.keys(store)) delete store[k];

    // Open a (fake) workspace so writes go to the real write path and the
    // auto-verification gate (_directoryName) is satisfied.
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

    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/chat")) {
        chatFetchCount++;
        const n = chatFetchCount;
        if (n === 1) {
          return streamOnce([
            toolCallChunk({ name: "write_file", path: "calc.ts", content: CLEAN }),
            doneChunk(),
          ]);
        }
        if (n === 2) {
          // Mandatory self-reflection confirm — text only.
          return streamOnce([textChunk("Done."), doneChunk()]);
        }
        if (n === 3) {
          // Verification repair turn: fix the type error via edit_file.
          return streamOnce([
            toolCallChunk({ name: "edit_file", path: "calc.ts", old_text: OLD, new_text: NEW }),
            doneChunk(),
          ]);
        }
        return streamOnce([textChunk("ok"), doneChunk()]);
      }
      if (url.includes("/api/agent/exec")) {
        execCount++;
        if (execCount === 1) {
          return new Response(
            JSON.stringify({
              stdout:
                "calc.ts(2,10): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.",
              stderr: "",
              exitCode: 1,
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    try {
      if (getCurrentTask()) abortCurrentTask();
    } catch {}
  });

  it("typechecks after writing, repairs failures, and re-checks until clean", async () => {
    const promise = runInBackground("write a calc file", null, [], "code", []);
    await waitFor(() => getCurrentTask() !== null);
    await promise;

    const task = getCurrentTask();
    expect(task?.status).toBe("done");

    // Two exec rounds: first fails, second passes after the repair turn.
    expect(execCount).toBe(2);
    // Four model calls: write, loop-ending text, self-reflection, verification repair.
    expect(chatFetchCount).toBe(4);

    const display = task?.displayContent || "";
    expect(display).toMatch(/Verifying changes/);
    expect(display).toMatch(/Verification passed/);
    expect(display).toContain("Fixed `calc.ts`");

    // The repair edit actually landed in the (fake) workspace.
    expect(store["calc.ts"]).toContain(NEW);
  });

  it("skips verification in ask mode (read-only, nothing written)", async () => {
    const promise = runInBackground("just asking", null, [], "ask", []);
    await waitFor(() => getCurrentTask() !== null);
    await promise;
    expect(execCount).toBe(0);
  });
});
