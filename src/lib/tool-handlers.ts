// tool-handlers.ts — Tool call handlers extracted from background-worker.ts
//
// Each handler processes a specific tool call from the LLM and returns
// the tool result XML string. This module reduces the size of
// background-worker.ts by ~600 lines.
//
// Context types are defined here to avoid circular imports.

import { TIMEOUTS, LIMITS, BLOCKED_COMMANDS, isBlockedCommand } from "./constants";

export interface ToolHandlerContext {
  /** Update the task status display */
  updateStatus: (status: string, detail?: string) => void;
  /** Append to the display content */
  appendDisplay: (text: string) => void;
  /** Replace the last status line */
  replaceLastStatus: (content: string, replacement: string) => string;
  /** Get current display content */
  getDisplayContent: () => string;
  /** Set display content */
  setDisplayContent: (content: string) => void;
  /** Emit activity event */
  emitActivity: (event: { type: string; message: string; agent: string }) => void;
  /** Emit preview */
  emitPreview: (url: string, type: string) => void;
  /** Request user approval */
  requestApproval: (type: string, summary: string, details: Record<string, unknown>, diff?: string, risk?: string) => Promise<boolean>;
  /** Write file */
  writeFile: (path: string, content: string) => Promise<boolean>;
  /** Read file */
  readFile: (path: string) => Promise<string>;
  /** Increment stat */
  bumpStat: (key: string) => void;
}

export interface ToolCall {
  name: string;
  [key: string]: unknown;
}

export interface ToolResult {
  xml: string;
  displayUpdate: string;
}

/**
 * Handle a search_code tool call.
 */
export function handleSearchCode(
  call: ToolCall,
  searchCode: (query: string) => string,
  ctx: ToolHandlerContext
): ToolResult {
  const query = String(call.query || "");
  ctx.updateStatus("tool_executing", `Searching "${query}"…`);
  ctx.appendDisplay(`searching [${query}]\n`);

  const results = searchCode(query);
  const matchCount = results.split("\n").length;

  return {
    xml: `<tool_result name="search_code" query="${query}">\n${results}\n</tool_result>\n`,
    displayUpdate: ctx.replaceLastStatus(
      ctx.getDisplayContent(),
      `[OK] Search "${query}" — ${matchCount} match(es)`
    ),
  };
}

/**
 * Handle a run_command tool call.
 */
export async function handleRunCommand(
  call: ToolCall,
  ctx: ToolHandlerContext
): Promise<ToolResult> {
  const command = String(call.command || "");

  // Safety: block destructive commands
  if (isBlockedCommand(command)) {
    return {
      xml: `<tool_result name="run_command" command="${command}">BLOCKED: command is too dangerous to execute</tool_result>\n`,
      displayUpdate: ctx.replaceLastStatus(
        ctx.getDisplayContent(),
        `[FAIL] Command blocked for safety: \`${command.slice(0, LIMITS.COMMAND_STATUS)}\``
      ),
    };
  }

  ctx.updateStatus("tool_executing", `Running: ${command.slice(0, LIMITS.COMMAND_PREVIEW)}...`);
  ctx.emitActivity({ type: "tool", message: `Running ${command.slice(0, LIMITS.COMMAND_PREVIEW)}`, agent: "coder" });
  ctx.appendDisplay(`running [${command}]\n`);

  // Request approval
  const approved = await ctx.requestApproval(
    "run_command",
    `Run: ${command}`,
    { command }
  );

  if (!approved) {
    ctx.bumpStat("rejectedActions");
    return {
      xml: `<tool_result name="run_command" command="${command}">rejected by user</tool_result>\n`,
      displayUpdate: ctx.replaceLastStatus(
        ctx.getDisplayContent(),
        `[FAIL] Command rejected: \`${command.slice(0, LIMITS.COMMAND_STATUS)}\``
      ),
    };
  }

  try {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const { stdout, stderr } = await execAsync(command, {
      timeout: TIMEOUTS.COMMAND_EXEC,
      maxBuffer: LIMITS.EXEC_BUFFER,
      env: { ...process.env, NODE_ENV: "development" },
    });

    ctx.bumpStat("commandsRun");
    const output = (stdout || "") + (stderr ? `\nSTDERR: ${stderr}` : "");
    const truncated = output.length > LIMITS.OUTPUT_TRUNCATE
      ? output.slice(0, LIMITS.OUTPUT_TRUNCATE) + "\n... [truncated]"
      : output;

    return {
      xml: `<tool_result name="run_command" command="${command}">\n${truncated}\n</tool_result>\n`,
      displayUpdate: ctx.replaceLastStatus(
        ctx.getDisplayContent(),
        `[OK] Command completed: \`${command.slice(0, LIMITS.COMMAND_STATUS)}\``
      ),
    };
  } catch (err: any) {
    ctx.bumpStat("failedSteps");
    const output = (err.stdout || "") + (err.stderr ? `\nSTDERR: ${err.stderr}` : "");
    const truncated = output.length > LIMITS.OUTPUT_TRUNCATE
      ? output.slice(0, LIMITS.OUTPUT_TRUNCATE) + "\n... [truncated]"
      : output;

    return {
      xml: `<tool_result name="run_command" command="${command}">\n${truncated || err.message}\n</tool_result>\n`,
      displayUpdate: ctx.replaceLastStatus(
        ctx.getDisplayContent(),
        `[FAIL] Command failed: \`${command.slice(0, LIMITS.COMMAND_STATUS)}\` (exit ${err.code || "?"})`
      ),
    };
  }
}

/**
 * Handle a todo_list tool call.
 */
export function handleTodoList(
  call: ToolCall,
  ctx: ToolHandlerContext
): ToolResult {
  const action = typeof call.action === "string" ? call.action : "";
  const items = Array.isArray(call.items)
    ? call.items.map((i: unknown) => typeof i === "string" ? i : JSON.stringify(i))
    : undefined;
  const completedIndex = typeof call.completed_index === "number" ? call.completed_index : undefined;

  let resultXml = "";
  let displayUpdate = ctx.getDisplayContent();

  if (action === "create" && items) {
    resultXml = `<tool_result name="todo_list" action="create">Created ${items.length} tasks</tool_result>\n`;
    displayUpdate = ctx.replaceLastStatus(displayUpdate, `[OK] Todo list created (${items.length} items)`);
  } else if (action === "update" && items) {
    resultXml = `<tool_result name="todo_list" action="update">Updated todo list</tool_result>\n`;
    displayUpdate = ctx.replaceLastStatus(displayUpdate, `[OK] Todo list updated`);
  } else if (action === "complete" && completedIndex !== undefined) {
    resultXml = `<tool_result name="todo_list" action="complete">Marked item ${completedIndex} done</tool_result>\n`;
    displayUpdate = ctx.replaceLastStatus(displayUpdate, `[OK] Task ${completedIndex + 1} completed`);
  } else if (action === "clear") {
    resultXml = `<tool_result name="todo_list" action="clear">Cleared todo list</tool_result>\n`;
    displayUpdate = ctx.replaceLastStatus(displayUpdate, `[OK] Todo list cleared`);
  }

  return { xml: resultXml, displayUpdate };
}

/**
 * Handle an ask_question tool call.
 */
export function handleAskQuestion(
  call: ToolCall,
  ctx: ToolHandlerContext
): ToolResult {
  const question = typeof call.question === "string" ? call.question : JSON.stringify(call.question ?? "");
  const options = Array.isArray(call.options)
    ? call.options.map((o: unknown) => typeof o === "string" ? o : JSON.stringify(o))
    : [];
  const allowFreeText = call.allow_free_text !== false;

  if (!question || options.length === 0) {
    return {
      xml: `<tool_result name="ask_question">error - missing question or options</tool_result>\n`,
      displayUpdate: ctx.getDisplayContent(),
    };
  }

  ctx.updateStatus("awaiting_approval", "Waiting for user answer…");
  ctx.appendDisplay(`asking [${question.slice(0, LIMITS.COMMAND_PREVIEW)}]\n`);

  return {
    xml: "", // Question is handled by the store, not inline
    displayUpdate: ctx.getDisplayContent(),
  };
}
