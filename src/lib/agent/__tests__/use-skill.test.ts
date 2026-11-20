/**
 * use-skill.test.ts — the chat lane's skill glue, end to end over REAL files.
 *
 * The two halves of chat-lane skill loading live in different files:
 *   - /api/agent/skills discovers .orplex/skills from the registered workspace
 *     (real fs, real loader);
 *   - native-tools' use_skill re-fetches a body and renders the tool_result.
 * Each half has its own test; a URL/response-shape mismatch between them would
 * still pass both and fail in the app. This test wires them together: apiFetch
 * is replaced with the actual route handler, against a temporary workspace.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { dispatchToolCall, type ToolContext } from "../native-tools";
import type { ToolCall } from "../../stream-reader";
import { GET as skillsRoute } from "../../../app/api/agent/skills/route";

let mockRoot = "";

// The route authenticates with sessionUserId (works for the packaged app's
// Ed25519 cookie as well as next-auth) — mock the helper it actually calls.
jest.mock("@/lib/server-session", () => ({ sessionUserId: async () => "test-user" }));
jest.mock("@/lib/workspace-cwd", () => ({
  getWorkspaceCwd: () => mockRoot,
  resolveWorkspaceCwd: async () => mockRoot || null,
}));

jest.mock("@orplex/sdk/lib/api-base", () => ({
  // The real route handler IS the server the renderer would talk to.
  apiFetch: async (path: string) => skillsRoute(new NextRequest(new URL(path, "http://localhost"))),
  withApiBase: (p: string) => p,
  API_BASE: "",
}));

// The mock above only covers the app's own `@/lib/api-base` shim. The tool layer
// lives in @orplex/sdk and imports its OWN ./api-base build, so mocking the
// package subpath does not intercept it — the real apiFetch then ran and died on
// "Failed to parse URL from /api/agent/skills", because Node's fetch has no base
// for a relative path. Patch the platform primitive both builds end up calling:
// a relative URL is answered by the real route handler.
const realFetch = global.fetch;
beforeAll(() => {
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("/")) {
      return skillsRoute(new NextRequest(new URL(url, "http://localhost")));
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});

afterAll(() => {
  global.fetch = realFetch;
});

function writeSkill(folder: string, content: string) {
  const dir = join(mockRoot, ".orplex", "skills", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content, "utf8");
}

function makeCtx(): ToolContext {
  return {
    mode: "code",
    readFiles: new Map(),
    contextFiles: new Map(),
    readResults: new Map(),
    abortSignal: null,
    fs: { readFile: null, writeFile: null, editFile: null, directoryName: "" },
    counters: {
      writtenFiles: new Map(),
      getTotalWrites: () => 0,
      setTotalWrites: () => {},
      setFilesChanged: () => {},
      bumpStat: () => {},
    },
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
    hooks: { fileWritten: () => {}, fileEdited: () => {} },
    scratchpad: { get: () => ({ sections: {} }) as never, update: () => {} },
    getDisplay: () => "",
    appendDisplay: () => {},
    replaceStatus: () => {},
    syncDisplay: () => {},
    setStatus: () => {},
    waitForAnswer: async () => "(test)",
  } as unknown as ToolContext;
}

const call = (args: Record<string, unknown>): ToolCall =>
  ({ name: "use_skill", ...args } as unknown as ToolCall);

describe("chat lane use_skill → /api/agent/skills over a real workspace", () => {
  beforeEach(() => {
    mockRoot = mkdtempSync(join(tmpdir(), "orplex-use-skill-"));
  });

  afterEach(() => {
    rmSync(mockRoot, { recursive: true, force: true });
  });

  it("returns the real SKILL.md body for a Windows-authored (CRLF + BOM) skill", async () => {
    writeSkill(
      "deploy",
      "\uFEFF---\r\nname: deploy\r\ndescription: Ship the app\r\n---\r\n\r\n1. Run the tests\r\n2. Tag the release\r\n",
    );

    const out = await dispatchToolCall(call({ name_of_skill: "deploy" }), makeCtx());
    expect(out.resultXml).toContain('skill="deploy"');
    expect(out.resultXml).toContain("1. Run the tests");
    expect(out.resultXml).toContain("2. Tag the release");
    expect(out.blocked).toBe(false);
  });

  it("matches the name case-insensitively, as the roster advertises it", async () => {
    writeSkill("deploy", "---\nname: Deploy App\ndescription: ship\n---\nBODY");

    const out = await dispatchToolCall(call({ name_of_skill: "  deploy app " }), makeCtx());
    expect(out.resultXml).toContain('skill="Deploy App"');
    expect(out.resultXml).toContain("BODY");
  });

  it("answers a typo with the real roster so the next call can succeed", async () => {
    writeSkill("deploy", "---\nname: deploy\ndescription: ship\n---\nBODY");
    writeSkill("review", "---\nname: review\ndescription: PR pass\n---\nREVIEW");

    const out = await dispatchToolCall(call({ name_of_skill: "deplyo" }), makeCtx());
    expect(out.resultXml).toContain("not found");
    expect(out.resultXml).toContain("- deploy");
    expect(out.resultXml).toContain("- review");
  });

  it("says a frontmatter-only skill has no steps instead of 'not found'", async () => {
    writeSkill("empty", "---\nname: empty\ndescription: nothing yet\n---\n");

    const out = await dispatchToolCall(call({ name_of_skill: "empty" }), makeCtx());
    expect(out.resultXml).toContain("no instructions");
    expect(out.resultXml).not.toContain("not found");
  });

  it("refuses a call with no skill name instead of inventing one", async () => {
    const out = await dispatchToolCall({ name: "use_skill" } as ToolCall, makeCtx());
    expect(out.blocked).toBe(true);
    expect(out.resultXml).toMatch(/name_of_skill/);
    expect(out.resultXml).not.toMatch(/not found/);
  });

  it("resolves a skill advertised at the tail of a full roster", async () => {
    // 32 skills is the cap; the last one is the one the old roster dropped.
    for (let i = 0; i < 32; i++) {
      writeSkill(`s${String(i).padStart(2, "0")}`, `---\nname: s${i}\ndescription: ${"detail ".repeat(20)}\n---\nBODY ${i}`);
    }

    const last = "s31";
    const out = await dispatchToolCall(call({ name_of_skill: last }), makeCtx());
    expect(out.resultXml).toContain("BODY 31");
  });
});
