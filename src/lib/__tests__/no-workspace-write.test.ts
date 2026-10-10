/**
 * no-workspace-write.test.ts — regression for the "AI says generated files"
 * bug with no folder open.
 *
 * The renderer only supplies fs.writeFile when a real folder is open. With no
 * folder, writeFileAudited used to fall through to an IN-MEMORY virtualFS and
 * return true, so write_file reported `success` and the agent announced files
 * it had created — while nothing reached disk and the next terminal command
 * failed with "no workspace folder open". These tests pin the truthful
 * behavior: refuse, name the real blocker, report NO success.
 */
import { dispatchToolCall, type ToolContext } from "../agent/native-tools";
import type { ToolCall } from "../stream-reader";

/** Minimal ToolContext with NO filesystem (no folder open). */
function ctxWithoutFs(): { ctx: ToolContext; displays: string[] } {
  const displays: string[] = [];
  let display = "";
  const written = new Map<string, string>();
  let totalWrites = 0;

  const ctx = {
    mode: "code",
    readFiles: new Map<string, number>(),
    contextFiles: new Map<string, string>(),
    readResults: new Map<string, string>(),
    abortSignal: null,
    // The exact shape the worker builds when no folder is open:
    // _readFile/_writeFile/_editFile are all null.
    fs: { readFile: null, writeFile: null, editFile: null, directoryName: "" },
    counters: {
      writtenFiles: written,
      getTotalWrites: () => totalWrites,
      setTotalWrites: (n: number) => { totalWrites = n; },
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
    getDisplay: () => display,
    appendDisplay: (t: string) => { display += t; },
    replaceStatus: () => {},
    syncDisplay: () => { displays.push(display); },
    setStatus: () => {},
  } as unknown as ToolContext;

  return { ctx, displays };
}

const writeCall = (name: string): ToolCall =>
  ({ name, path: "src/hello.ts", content: "export const hi = 1;\n" } as ToolCall);

describe("write tools with no folder open", () => {
  it.each(["write_file", "write_file_chunk", "edit_file", "batch_edit"])(
    "%s refuses instead of reporting a fake success",
    async (name) => {
      const { ctx } = ctxWithoutFs();
      const outcome = await dispatchToolCall(writeCall(name), ctx);

      // The bug: these returned `blocked: false` with a `success` payload.
      expect(outcome.blocked).toBe(true);
      expect(outcome.resultXml).not.toContain(">success<");
      expect(outcome.resultXml).toContain("no folder is open");
      expect(outcome.resultXml).toContain("Nothing was written");
    }
  );

  it("tells the model how to unblock itself (open a folder, then retry)", async () => {
    const { ctx } = ctxWithoutFs();
    const outcome = await dispatchToolCall(writeCall("write_file"), ctx);
    expect(outcome.resultXml).toContain("Ctrl+O");
    expect(outcome.resultXml).toContain("retry");
  });

  it("does NOT refuse when a filesystem is available (server lane / folder open)", async () => {
    const { ctx } = ctxWithoutFs();
    // A working fs — the guard must not fire (ask mode is the only refusal left).
    (ctx.fs as { writeFile: unknown }).writeFile = async () => true;
    (ctx.fs as { readFile: unknown }).readFile = async () => "";
    const outcome = await dispatchToolCall(writeCall("write_file"), ctx);
    expect(outcome.resultXml).toContain(">success<");
    expect(outcome.resultXml).not.toContain("no folder is open");
  });
});