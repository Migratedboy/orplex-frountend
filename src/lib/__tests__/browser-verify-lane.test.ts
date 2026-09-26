/**
 * browser-verify-lane.test.ts — The worker's auto browser-verification lane:
 * after UI writes pass the typecheck, the agent renders its own app via
 * /api/agent/verify, feeds console errors into one repair turn, and
 * re-verifies. Non-UI work and busy ports must skip the lane.
 */
import { runInBackground, setFileSystemAccess } from "../background-worker";
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

const ORIGINAL_FETCH = global.fetch;
let store: Record<string, string> = {};
let chatFetchCount = 0;
let verifyCount = 0;
let verifyResponses: any[] = [];
let verifyBodies: any[] = [];
let repairSeen = false;

beforeEach(() => {
  store = {};
  chatFetchCount = 0;
  verifyCount = 0;
  verifyResponses = [];
  verifyBodies = [];
  repairSeen = false;

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

function setupFetch(opts?: { portBusy?: boolean }) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    // Port probe (no body) vs real verify call (JSON body)
    if (url.includes("/api/agent/verify") || /localhost:\d+\/$/.test(url) || /localhost:\d+\/$/.test(url.replace(/\/$/, ""))) {
      const hasBody = !!init?.body;
      if (!hasBody) {
        // Port probe: busy → 200, free → reject
        if (opts?.portBusy) return new Response("{}", { status: 200 });
        throw new Error("connection refused");
      }
      verifyCount++;
      verifyBodies.push(JSON.parse(String(init?.body)));
      const resp = verifyResponses[Math.min(verifyCount - 1, verifyResponses.length - 1)];
      return new Response(JSON.stringify(resp), { status: 200 });
    }
    if (url.includes("/api/chat")) {
      chatFetchCount++;
      const n = chatFetchCount;
      if (n === 1) {
        return streamOnce([
          toolCallChunk({
            name: "write_file",
            path: "src/components/Dashboard.tsx",
            content: 'export default function Dashboard() { return <div onClick={() => undefinedfoo()}>hi</div>; }\n',
          }),
          doneChunk(),
        ]);
      }
      if (n === 2) return streamOnce([textChunk("Written."), doneChunk()]);
      if (n === 3) return streamOnce([textChunk("Re-checked — clean."), doneChunk()]); // self-reflection
      if (repairSeen) {
        // Post-repair text turn
        return streamOnce([textChunk("Fixed."), doneChunk()]);
      }
      // Browser-repair turn: fix the file
      repairSeen = true;
      return streamOnce([
        toolCallChunk({
          name: "edit_file",
          path: "src/components/Dashboard.tsx",
          old_text: "undefinedfoo()",
          new_text: "boot()",
        }),
        doneChunk(),
      ]);
    }
    if (url.includes("/api/agent/exec")) {
      // typecheck passes first try
      return new Response(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }), { status: 200 });
    }
    if (url.includes("/api/agent/orchestrate")) {
      return new Response(JSON.stringify({ ok: true, consensus: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

describe("worker auto browser-verification lane", () => {
  it("verifies UI work, repairs on console errors, and re-verifies clean", async () => {
    verifyResponses = [
      { success: false, consoleErrors: ["ReferenceError: undefinedfoo is not defined"], timeline: [] },
      { success: true, consoleErrors: [], screenshotPath: ".orplex-verify/shot.png", timeline: [] },
    ];
    setupFetch();

    // "chart widget" phrasing stays below the isComplexTask bar — this test
    // exercises the browser lane, not the SPARC plan gate.
    const promise = runInBackground("build a chart widget with a summary table", null, [], "code", []);
    await waitFor(() => getCurrentTask() !== null);
    await promise;

    const task = getCurrentTask();
    expect(task?.status).toBe("done");

    // Two verify calls: initial + post-repair re-check
    expect(verifyCount).toBe(2);
    const firstBody = verifyBodies[0];
    expect(firstBody.workDir).toBe("test-workspace");
    expect(firstBody.recordVideo).toBe(true);
    expect(firstBody.urlPolicy).toEqual({});

    const display = task?.displayContent || "";
    expect(display).toMatch(/Browser verification…/);
    expect(display).toMatch(/UI broken — repairing…/);
    expect(display).toMatch(/Browser verification passed/);
    expect(store["src/components/Dashboard.tsx"]).toContain("boot()");
  });

  it("passes immediately when the app renders clean", async () => {
    verifyResponses = [{ success: true, consoleErrors: [], screenshotPath: "s.png", timeline: [] }];
    setupFetch();

    const promise = runInBackground("build a landing page with hero section", null, [], "code", []);
    await waitFor(() => getCurrentTask() !== null);
    await promise;

    expect(verifyCount).toBe(1);
    const display = getCurrentTask()?.displayContent || "";
    expect(display).toMatch(/Browser verification passed/);
    expect(display).not.toMatch(/UI broken/);
  });

  it("skips the lane for non-UI work (config-only changes)", async () => {
    let verifyCalled = false;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((url.includes("/api/agent/verify") || /localhost:\d+/.test(url)) && !init?.body) {
        verifyCalled = true;
        throw new Error("should not probe");
      }
      if (url.includes("/api/chat")) {
        chatFetchCount++;
        const n = chatFetchCount;
        if (n === 1) {
          return streamOnce([
            toolCallChunk({ name: "write_file", path: "tsconfig.json", content: '{ "compilerOptions": {} }\n' }),
            doneChunk(),
          ]);
        }
        return streamOnce([textChunk("Done."), doneChunk()]);
      }
      if (url.includes("/api/agent/exec")) {
        return new Response(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const promise = runInBackground("update the tsconfig build options", null, [], "code", []);
    await waitFor(() => getCurrentTask() !== null);
    await promise;

    expect(verifyCalled).toBe(false);
    const display = getCurrentTask()?.displayContent || "";
    expect(display).not.toMatch(/Browser verification/);
  });

  it("skips when the port is busy (user's dev server already running)", async () => {
    verifyResponses = [{ success: true, consoleErrors: [], timeline: [] }];
    setupFetch({ portBusy: true });

    const promise = runInBackground("build a settings page with form fields", null, [], "code", []);
    await waitFor(() => getCurrentTask() !== null);
    await promise;

    expect(verifyCount).toBe(0);
    const display = getCurrentTask()?.displayContent || "";
    expect(display).toMatch(/Browser verification skipped/);
  });
});
