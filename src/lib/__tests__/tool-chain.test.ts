/**
 * tool-chain.test.ts — The connector-line tool rows.
 *
 * The transcript is plain text (`analysing [path]`, `running [cmd]`, then
 * `[OK] …` / `[FAIL] …`), so every row the chain shows is derived: which glyph
 * sits on the line, what the mono arg reads, and whether the row settles as
 * success/error or keeps spinning. Grouping is the other half of the contract:
 * consecutive tools + adjacent reasoning collapse into ONE chain so a single
 * connector line runs through the whole run, while prose breaks it.
 */
import { parseContent, type ContentSegment } from "../message-content";
import {
  buildChainGroups,
  labelForTool,
  rowFromStatus,
  rowFromResult,
  rowFromToolCall,
  rowFromToolResult,
  type ChainGroup,
  type ChainItem,
  type ToolRow,
} from "../tool-chain";

function groupsOf(raw: string, liveThinking = false): ChainGroup[] {
  return buildChainGroups(parseContent(raw), liveThinking);
}

/** First chain in the parsed transcript (throws if the input built none). */
function firstChain(raw: string, liveThinking = false): ChainItem[] {
  const group = groupsOf(raw, liveThinking).find((g) => g.type === "chain");
  if (!group || group.type !== "chain") throw new Error(`no chain built from:\n${raw}`);
  return group.items;
}

function rowsOf(raw: string, liveThinking = false): ToolRow[] {
  return firstChain(raw, liveThinking)
    .filter((item): item is Extract<ChainItem, { type: "tool" }> => item.type === "tool")
    .map((item) => item.row);
}

function status(action: string, path: string, detail?: string): ContentSegment {
  return { type: "status", content: `${action} [${path}]`, action, path, detail };
}

describe("row builders", () => {
  it("maps a started tool to its name, glyph family and args", () => {
    const row = rowFromStatus(status("analysing", "src/app/page.tsx"));
    expect(row).toMatchObject({
      name: "Read",
      kind: "read",
      args: "src/app/page.tsx",
      state: "running",
      detail: "",
    });
    expect(row.waiting).toBeFalsy();

    expect(rowFromStatus(status("running", "ls -la"))).toMatchObject({
      name: "Run",
      kind: "run",
      args: "ls -la",
      state: "running",
    });
    expect(rowFromStatus(status("searching web", "nextjs auth"))).toMatchObject({
      name: "Web Search",
      kind: "search",
      args: "nextjs auth",
    });
    expect(rowFromStatus(status("editing", "src/lib/auth.ts"))).toMatchObject({
      name: "Edit",
      kind: "write",
      args: "src/lib/auth.ts",
    });
  });

  it("keeps the approval tail and flags it as waiting", () => {
    const row = rowFromStatus(status("running", "rm -rf build", "— awaiting approval"));
    expect(row.detail).toBe("— awaiting approval");
    expect(row.waiting).toBe(true);
  });

  it("reads the mcp status line as one MCP row", () => {
    const row = rowFromStatus(status("mcp", "Linear", "create_issue"));
    expect(row).toMatchObject({
      name: "MCP",
      kind: "other",
      args: "Linear: create_issue",
      state: "running",
    });
  });

  it("derives an orphan result row from its own text", () => {
    const ok = rowFromResult({
      type: "success",
      content: "[OK] Read `src/lib/tool-text.ts` (cached — already read 3×)",
      detail: "Read `src/lib/tool-text.ts` (cached — already read 3×)",
    });
    expect(ok).toMatchObject({ name: "Read", kind: "read", args: "src/lib/tool-text.ts", state: "success" });

    const fail = rowFromResult({
      type: "error",
      content: "[FAIL] Edit `src/a.ts` — text not found",
      detail: "Edit `src/a.ts` — text not found",
    });
    expect(fail).toMatchObject({ name: "Edit", kind: "write", args: "src/a.ts", state: "error" });
  });

  it("labels tool-call rows from the tool name and prefers path args", () => {
    const call = rowFromToolCall({
      type: "tool_call",
      content: JSON.stringify({ name: "run_command", command: "npx jest --forceExit" }),
      name: "run_command",
    });
    expect(call).toMatchObject({ name: "Run", kind: "run", state: "running" });
    expect(call.args).toBe("npx jest --forceExit");

    expect(labelForTool("read_file")).toEqual(["Read", "read"]);
    expect(labelForTool("take_screenshot")).toEqual(["Screenshot", "browser"]);
    expect(labelForTool("mcp__linear__create_issue")).toEqual(["MCP", "other"]);
    expect(labelForTool("some_new_tool")[0]).toBe("some new tool");
  });

  it("marks raw tool results that report an error", () => {
    const bad = rowFromToolResult({ type: "tool_result", content: "[MCP ERROR] Server not connected" });
    expect(bad.state).toBe("error");
    const good = rowFromToolResult({ type: "tool_result", content: "200 OK" });
    expect(good.state).toBe("success");
  });
});

describe("grouping", () => {
  it("puts a started tool alone in a chain", () => {
    const rows = rowsOf("analysing [src/app/page.tsx]");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Read", state: "running", args: "src/app/page.tsx" });
  });

  it("merges a result line into the running row above it", () => {
    const rows = rowsOf("running [ls -la]\n[OK] Command finished — exit 0");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Run", args: "ls -la", state: "success" });
    expect(rows[0].detail).toContain("Command finished — exit 0");
    expect(rows[0].waiting).toBe(false);
  });

  it("keeps a failure as an error row", () => {
    const rows = rowsOf("editing [src/a.ts]\n[FAIL] Edit `src/a.ts` — text not found");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Edit", state: "error" });
    expect(rows[0].detail).toContain("text not found");
  });

  it("collapses consecutive tools into one chain", () => {
    const items = firstChain(
      "listing [src]\n[OK] Listed 4 file(s)\nanalysing [src/app.ts]\n[OK] Read `src/app.ts` lines 1–80"
    );
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.type === "tool")).toBe(true);
    const [list, read] = items as Array<Extract<ChainItem, { type: "tool" }>>;
    expect(list.row).toMatchObject({ name: "List", state: "success" });
    expect(read.row).toMatchObject({ name: "Read", state: "success" });
  });

  it("runs reasoning through the same connector line as the tools below it", () => {
    const items = firstChain(
      "[THINKING]\nPlan the refactor.\n[/THINKING]\nrunning [npx tsc --noEmit]\n[OK] No errors"
    );
    expect(items[0]).toMatchObject({ type: "thinking", live: false });
    expect(items).toHaveLength(2);
    expect((items[1] as Extract<ChainItem, { type: "tool" }>).row).toMatchObject({
      name: "Run",
      state: "success",
    });
  });

  it("only marks the tail reasoning live", () => {
    const raw = "[THINKING]\nplanning\n[/THINKING]\nreading [src/a.ts]\n[OK] Read `src/a.ts`";
    const live = firstChain(raw, true);
    expect(live[0]).toMatchObject({ type: "thinking", live: false });

    // Tail reasoning with no tool under it stays a solo block — and it is the
    // live one (the ThinkingCard, not a second indicator).
    const tail = groupsOf("[THINKING]still thinking[/THINKING]", true);
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({ type: "solo", live: true });
  });

  it("keeps standalone reasoning out of a chain", () => {
    const groups = groupsOf("[THINKING]just reasoning[/THINKING]");
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ type: "solo" });

    const prose = groupsOf("Thanks! Here's what I did.");
    expect(prose).toEqual([{ type: "solo", segment: { type: "text", content: "Thanks! Here's what I did." } }]);
  });

  it("breaks the chain at prose and starts a new one after it", () => {
    const groups = groupsOf(
      "running [ls]\n[OK] Command done\n\nAll green — merging now.\n\nreading [src/a.ts]\n[OK] Read `src/a.ts`"
    );
    expect(groups).toHaveLength(3);
    expect(groups[0].type).toBe("chain");
    expect(groups[1].type).toBe("solo");
    expect(groups[2].type).toBe("chain");
  });

  it("renders a lone result as a chain row instead of leaving it bare", () => {
    const rows = rowsOf("[FAIL] MCP Linear: create_issue — 401 unauthorized");
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("error");
    expect(rows[0].name).toBe("Tool");
  });
});
