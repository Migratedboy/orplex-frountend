/**
 * create-file-dispatch.test.ts — the create_file tool handler contract.
 *
 * create_file is the "memory, not disk" deliverable lane: it refuses without
 * a registered workspace, POSTs the content to the local staging route, and
 * stamps a [FILECARD] locator into the display transcript on success. It must
 * NEVER write files through ctx.fs and never log content on failure.
 */
import { dispatchToolCall, type ToolContext } from "../native-tools";
import type { ToolCall } from "../../stream-reader";

const ORIGINAL_FETCH = global.fetch;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    mode: "code",
    owner: { userId: null, conversationId: "conv-9" },
    readFiles: new Map<string, number>(),
    contextFiles: new Map<string, string>(),
    readResults: new Map<string, string>(),
    abortSignal: null,
    fs: {} as ToolContext["fs"],
    counters: {
      writtenFiles: new Set<string>(),
      getTotalWrites: () => 0,
      setTotalWrites: () => {},
      setFilesChanged: () => {},
      bumpStat: () => {},
    } as unknown as ToolContext["counters"],
    fileTree: [],
    fileContents: {},
    store: {
      setTodos: () => {},
      completeTodo: () => {},
      clearTodos: () => {},
      setQuestion: () => {},
      answerQuestion: () => {},
    },
    stats: { commandRun: () => {}, failedStep: () => {}, rejectedAction: () => {} },
    hooks: { fileWritten: jest.fn(), fileEdited: jest.fn() },
    getDisplay: () => "",
    appendDisplay: (t: string) => { display += t; },
    scratchpad: undefined,
    setStatus: () => {},
    replaceStatus: () => {},
    syncDisplay: () => {},
    waitForAnswer: async () => "",
    ...overrides,
  } as ToolContext;
}

let display = "";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const NO_CWD: ToolCall = { name: "create_file", filename: "out.md", content: "body" } as unknown as ToolCall;

beforeEach(() => {
  display = "";
});

afterAll(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe("create_file — workspace gate (inverted: works ONLY with no project open)", () => {
  it("stages when no workspace is open (the deliverable lane's whole purpose)", async () => {
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/agent/workspace-cwd")) return jsonResponse({ cwd: null });
      if (url.includes("/api/files")) {
        return jsonResponse({
          id: "b7f3d1a2-8c41-4e55-9f10-aabbccddeeff",
          filename: "out.md",
          bytes: 123,
          lines: 4,
          expiresAt: Date.now() + 1000,
          evicted: null,
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const ctx = makeCtx();
    const outcome = await dispatchToolCall(NO_CWD, ctx);
    expect(outcome.blocked).toBe(false);
    expect(outcome.resultXml).toContain("success");
    const marker = display.split("\n").find((l) => l.startsWith("[FILECARD]:"));
    expect(marker).toBeTruthy();
    expect(ctx.hooks.fileWritten).not.toHaveBeenCalled();
  });

  it("accepts write_file's arg shape (path alias) from habit-driven models", async () => {
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/agent/workspace-cwd")) return jsonResponse({ cwd: null });
      if (url.includes("/api/files")) {
        return jsonResponse({
          id: "b7f3d1a2-8c41-4e55-9f10-aabbccdde999",
          filename: "outnote.md",
          bytes: 5,
          lines: 1,
          expiresAt: Date.now() + 1000,
          evicted: null,
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const ctx = makeCtx();
    const call = { name: "create_file", path: "outnote.md", content: "with path arg" } as unknown as ToolCall;
    const outcome = await dispatchToolCall(call, ctx);
    expect(outcome.blocked).toBe(false);
    expect(outcome.resultXml).toContain("success");
    // The staging POST carried the ALIASED name:
    const marker = display.split("\n").find((l) => l.startsWith("[FILECARD]:"));
    const payload = JSON.parse((marker ?? "").slice("[FILECARD]:".length)) as { filename: string };
    expect(payload.filename).toBe("outnote.md");
  });

  it("refuses and redirects to write_file when a project IS open", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes("/api/agent/workspace-cwd")) return jsonResponse({ cwd: "D:\\proj" });
      throw new Error("must not be reached");
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const ctx = makeCtx();
    const outcome = await dispatchToolCall(NO_CWD, ctx);
    expect(outcome.blocked).toBe(true);
    expect(outcome.resultXml).toContain("project folder IS open");
    expect(outcome.resultXml).toContain("write_file");
    expect(display).not.toContain("[FILECARD]");
    expect(ctx.hooks.fileWritten).not.toHaveBeenCalled();
  });
});

describe("create_file — successful staging", () => {
  it("POSTs to the local store, reports success, and stamps a filecard locator", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/api/agent/workspace-cwd")) return jsonResponse({ cwd: null });
      if (url.includes("/api/files")) {
        return jsonResponse({
          id: "b7f3d1a2-8c41-4e55-9f10-aabbccddeeff",
          filename: "out.md",
          bytes: 123,
          lines: 4,
          expiresAt: Date.now() + 1000,
          evicted: null,
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const ctx = makeCtx();
    const call = { name: "create_file", filename: "out.md", content: "line1\nline2" } as unknown as ToolCall;
    const outcome = await dispatchToolCall(call, ctx);

    expect(outcome.blocked).toBe(false);
    expect(outcome.resultXml).toContain('file_id="b7f3d1a2');
    expect(outcome.resultXml).toContain("success");

    // Staging POST carried the content + owner attribution and NEVER hit disk:
    const post = calls.find((c) => c.url.includes("/api/files"));
    expect(post).toBeTruthy();
    const sent = JSON.parse(String(post?.init?.body)) as { filename: string; content: string; conversationId: string };
    expect(sent.filename).toBe("out.md");
    expect(sent.content).toBe("line1\nline2");
    expect(sent.conversationId).toBe("conv-9");
    expect(ctx.hooks.fileWritten).not.toHaveBeenCalled();

    // Card locator landed in the transcript as its own line:
    expect(display).toContain("staging [out.md]");
    const marker = display.split("\n").find((l) => l.startsWith("[FILECARD]:"));
    expect(marker).toBeTruthy();
    const payload = JSON.parse((marker ?? "").slice("[FILECARD]:".length)) as { id: string; filename: string };
    expect(payload.id).toBe("b7f3d1a2-8c41-4e55-9f10-aabbccddeeff");
    expect(payload.filename).toBe("out.md");
  });

  it("relays the eviction notice when the 2-file cap displaced a file", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes("/api/agent/workspace-cwd")) return jsonResponse({ cwd: null });
      if (url.includes("/api/files")) {
        return jsonResponse({
          id: "b7f3d1a2-8c41-4e55-9f10-aabbccdde000",
          filename: "new.md",
          bytes: 10,
          lines: 1,
          expiresAt: Date.now() + 1000,
          evicted: { id: "b7f3d1a2-8c41-4e55-9f10-aabbccdde111", filename: "old.md" },
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const ctx = makeCtx();
    const call = { name: "create_file", filename: "new.md", content: "x" } as unknown as ToolCall;
    const outcome = await dispatchToolCall(call, ctx);
    expect(outcome.blocked).toBe(false);
    expect(outcome.resultXml).toContain("old.md");
    expect(outcome.resultXml).toContain("evicted");
    const marker = display.split("\n").find((l) => l.startsWith("[FILECARD]:"));
    const payload = JSON.parse((marker ?? "").slice("[FILECARD]:".length)) as { evicted?: { filename: string } };
    expect(payload.evicted?.filename).toBe("old.md");
  });

  it("reports an identical restage honestly instead of pretending it made a new file", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes("/api/agent/workspace-cwd")) return jsonResponse({ cwd: null });
      if (url.includes("/api/files")) {
        return jsonResponse({
          id: "b7f3d1a2-8c41-4e55-9f10-aabbccddead0",
          filename: "summary.md",
          bytes: 42,
          lines: 3,
          expiresAt: Date.now() + 1000,
          evicted: null,
          duplicate: true,
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const ctx = makeCtx();
    const call = { name: "create_file", filename: "summary.md", content: "hi" } as unknown as ToolCall;
    const outcome = await dispatchToolCall(call, ctx);
    expect(outcome.blocked).toBe(false);
    expect(outcome.resultXml).toContain("ALREADY staged");
    expect(outcome.resultXml).not.toContain("staged `summary.md` ("); // no "success: staged" phrasing
    // Card locator still stamped (the existing card re-surfaces), minus an
    // eviction claim that never happened:
    const marker = display.split("\n").find((l) => l.startsWith("[FILECARD]:"));
    const payload = JSON.parse((marker ?? "").slice("[FILECARD]:".length)) as { id: string; evicted: { filename: string } | null };
    expect(payload.id).toBe("b7f3d1a2-8c41-4e55-9f10-aabbccddead0");
    expect(payload.evicted).toBeNull();
  });
});

describe("create_file — refusal paths", () => {
  it("surfaces the route's validation error as an honest refusal", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes("/api/agent/workspace-cwd")) return jsonResponse({ cwd: null });
      if (url.includes("/api/files")) return jsonResponse({ error: "error: invalid filename" }, 400);
      return jsonResponse({ error: "not found" }, 404);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const ctx = makeCtx();
    const call = { name: "create_file", filename: "bad-name.md", content: "x" } as unknown as ToolCall;
    const outcome = await dispatchToolCall(call, ctx);
    expect(outcome.blocked).toBe(true);
    expect(outcome.resultXml).toContain("refused: invalid filename");
    expect(display).not.toContain("[FILECARD]");
  });

  it("reports an unavailable staging service (hosted lane) rather than faking success", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes("/api/agent/workspace-cwd")) return jsonResponse({ cwd: null });
      // Staging route absent in the cloud split:
      return jsonResponse({ error: "Not found" }, 404);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const ctx = makeCtx();
    const call = { name: "create_file", filename: "x.md", content: "x" } as unknown as ToolCall;
    const outcome = await dispatchToolCall(call, ctx);
    expect(outcome.blocked).toBe(true);
    expect(outcome.resultXml).toContain("refused:");
    expect(display).not.toContain("[FILECARD]");
  });
});

describe("incomplete tool calls — honest refusals (audit fixes)", () => {
  it("a known tool with missing args is refused as INCOMPLETE, not 'not available'", async () => {
    const ctx = makeCtx();
    const call = { name: "read_file" } as unknown as ToolCall; // no path — exactly what a dropped args fragment yields
    const outcome = await dispatchToolCall(call, ctx);
    expect(outcome.resultXml).toContain("INCOMPLETE");
    expect(outcome.resultXml).toContain("missing required argument(s) (path)");
    expect(outcome.resultXml).not.toContain("not available in this environment");
    expect(outcome.blocked).toBe(true);
  });

  it("a genuinely unknown tool still gets the roster refusal", async () => {
    const ctx = makeCtx();
    const call = { name: "mystery_tool", content: "x" } as unknown as ToolCall;
    const outcome = await dispatchToolCall(call, ctx);
    expect(outcome.resultXml).toContain("not available in this environment");
    expect(outcome.blocked).toBe(false);
  });

  it("ask_clarification without a question refuses instead of parking the run", async () => {
    const wait = jest.fn(async () => "never");
    const ctx = makeCtx({ waitForAnswer: wait as unknown as ToolContext["waitForAnswer"] });
    const call = { name: "ask_clarification" } as unknown as ToolCall;
    const outcome = await dispatchToolCall(call, ctx);
    expect(outcome.resultXml).toContain("missing or invalid question");
    expect(outcome.blocked).toBe(true);
    // The old bug parked the run on waitForAnswer with a question rendered
    // literally as `""` — the run must never reach the parking hook here.
    expect(wait).not.toHaveBeenCalled();
  });

  it("scratchpad_update without content refuses instead of recording the string `\"\"`", async () => {
    const ctx = makeCtx({
      scratchpad: { update: jest.fn() } as unknown as NonNullable<ToolContext["scratchpad"]>,
    });
    const call = { name: "scratchpad_update", section: "plan" } as unknown as ToolCall;
    const outcome = await dispatchToolCall(call, ctx);
    expect(outcome.resultXml).toContain("missing or empty content");
    expect(outcome.resultXml).not.toContain("recorded (");
    expect(outcome.blocked).toBe(false);
  });
});
