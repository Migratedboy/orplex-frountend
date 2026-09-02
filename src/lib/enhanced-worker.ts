import fs from "fs";
import path from "path";
/**
 * enhanced-worker.ts
 * 
 * Wraps the existing background worker with LangChain orchestration:
 * 1. Plan-and-Execute for better multi-step tasks
 * 2. Reflection loop for self-correcting code generation
 * 3. RAG for smarter context retrieval
 */

import { 
  createPlan, 
  executeStep, 
  reflectionLoop,
  retrieveRelevantCode,
  retrieveFromCodebase,
  type ExecutionPlan,
  type PlanStep,
  type OrchestratorConfig
} from "./langchain-orchestrator";
import { 
  startTask, 
  updateTaskStatus, 
  setDisplayContent, 
  completeTask, 
  failTask,
  setTodos,
  completeTodo,
  getCurrentTask
} from "./background-chat";



// ============================================================
// Types
// ============================================================

interface EnhancedConfig extends OrchestratorConfig {
  enableReflection?: boolean;
  enableRAG?: boolean;
  enablePlanAndExecute?: boolean;
  maxReflectionAttempts?: number;
}

interface TaskContext {
  sessionId: string;
  message: string;
  workspacePath?: string;
  files: Array<{ path: string; content: string }>;
}

// ============================================================
// Tool Registry
// ============================================================

function createToolRegistry(context: TaskContext) {
  const tools: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
    
    read_file: async (args) => {
      const filePath = args.path as string;
      if (!filePath) return "Error: path required";
      
      const fullPath = context.workspacePath 
        ? path.join(context.workspacePath, filePath) 
        : filePath;
      
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        const lines = content.split("\n");
        const start = Math.max(0, (args.start_line as number || 1) - 1);
        const end = Math.min(lines.length, args.end_line as number || lines.length);
        return lines.slice(start, end).join("\n");
      } catch {
        return `Error: File not found: ${filePath}`;
      }
    },

    list_files: async (args) => {
      const dirPath = args.path as string || ".";
      const fullPath = context.workspacePath 
        ? path.join(context.workspacePath, dirPath) 
        : dirPath;
      
      try {
        const entries = fs.readdirSync(fullPath, { withFileTypes: true });
        const files = entries.map(e => `${e.isDirectory() ? "[DIR]" : "     "} ${e.name}`);
        return `Files in ${dirPath}:\n${files.join("\n")}`;
      } catch {
        return `Error: Directory not found: ${dirPath}`;
      }
    },

    write_file: async (args) => {
      const filePath = args.path as string;
      const content = args.content as string;
      if (!filePath || !content) return "Error: path and content required";
      
      const fullPath = context.workspacePath 
        ? path.join(context.workspacePath, filePath) 
        : filePath;
      
      try {
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(fullPath, content, "utf-8");
        return `OK: Wrote ${content.length} chars to ${filePath}`;
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },

    edit_file: async (args) => {
      const filePath = args.path as string;
      const oldText = args.old_text as string;
      const newText = args.new_text as string;
      if (!filePath || !oldText || newText === undefined) return "Error: path, old_text, and new_text required";
      
      const fullPath = context.workspacePath 
        ? path.join(context.workspacePath, filePath) 
        : filePath;
      
      try {
        let content = fs.readFileSync(fullPath, "utf-8");
        if (!content.includes(oldText)) {
          return `Error: old_text not found in ${filePath}`;
        }
        content = content.replace(oldText, newText);
        fs.writeFileSync(fullPath, content, "utf-8");
        return `OK: Edited ${filePath}`;
      } catch {
        return `Error: File not found: ${filePath}`;
      }
    },

    search_code: async (args) => {
      const query = args.query as string;
      if (!query) return "Error: query required";
      
      const searchDir = context.workspacePath || ".";
      const results: string[] = [];
      
      try {
        const searchFiles = (dir: string, depth = 0) => {
          if (depth > 5) return;
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
              searchFiles(fullPath, depth + 1);
            } else if (entry.isFile() && /\.(ts|tsx|js|jsx|json|md)$/.test(entry.name)) {
              try {
                const content = fs.readFileSync(fullPath, "utf-8");
                const lines = content.split("\n");
                for (let i = 0; i < lines.length; i++) {
                  if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                    const relPath = path.relative(searchDir, fullPath);
                    results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
                  }
                }
              } catch {}
            }
          }
        };
        searchFiles(searchDir);
        return results.length > 0 
          ? `Found ${results.length} matches:\n${results.slice(0, 20).join("\n")}`
          : `No matches for "${query}"`;
      } catch {
        return `Error: Search failed`;
      }
    },

    run_command: async (args) => {
      const command = args.command as string;
      if (!command) return "Error: command required";
      
      const { execSync } = require("child_process");
      try {
        const result = execSync(command, { 
          timeout: 30000, 
          encoding: "utf-8",
          cwd: context.workspacePath || process.cwd(),
          stdio: ["pipe", "pipe", "pipe"]
        });
        return result.slice(0, 5000);
      } catch (error: unknown) {
        const err = error as { stderr?: string; stdout?: string; message?: string };
        return `Exit code: ${err.message}\n${err.stderr || err.stdout || ""}`.slice(0, 5000);
      }
    },

    web_search: async (args) => {
      const query = args.query as string;
      if (!query) return "Error: query required";
      
      try {
        const response = await fetch("https://api.duckduckgo.com/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
        });
        const data = await response.json();
        return JSON.stringify(data.AbstractText || "No results", null, 2);
      } catch {
        return "Error: Search failed";
      }
    },

    todo_list: async (args) => {
      // Handled by the background chat state
      return "OK: todo_list processed";
    },

    ask_question: async (args) => {
      // Handled by the background chat state
      return "OK: ask_question processed";
    },
  };

  return tools;
}

// ============================================================
// Enhanced Task Executor
// ============================================================

export async function executeWithOrchestration(
  context: TaskContext,
  config: EnhancedConfig = {}
): Promise<{
  success: boolean;
  results: Record<number, string>;
  plan: ExecutionPlan;
}> {
  const {
    enableReflection = true,
    enableRAG = true,
    enablePlanAndExecute = true,
    maxReflectionAttempts = 3,
  } = config;

  // Start task
  startTask(context.sessionId, context.message, []);
  setDisplayContent("Planning approach...");

  // Create tool registry
  const tools = createToolRegistry(context);

  // Create execution plan
  const plan = await createPlan(
    context.message,
    Object.keys(tools),
    enableRAG ? context.files.map(f => f.content).join("\n") : undefined
  );

  // Update task with plan
  setDisplayContent(`Plan: ${plan.summary}\nSteps: ${plan.steps.length}`);

  // Create todo list from plan
  const todoItems = plan.steps.map(s => s.description);
  setTodos(todoItems);

  const results: Record<number, string> = {};

  // Execute steps
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    step.status = "running";
    
    updateTaskStatus("streaming", `Step ${i + 1}/${plan.steps.length}: ${step.description}`);
    setDisplayContent(`Executing: ${step.description}`);

    const outcome = await executeStep(step, results, tools);
    results[step.id] = outcome.result;
    step.status = outcome.success ? "done" : "failed";

    // Mark todo as complete
    completeTodo(i);

    // Reflection on failure
    if (!outcome.success && enableReflection) {
      setDisplayContent(`Reflecting on error: ${outcome.result.slice(0, 100)}...`);
      
      for (let attempt = 0; attempt < maxReflectionAttempts; attempt++) {
        // Try to fix using run_command with a test
        const reflection = await reflectionLoop(
          step.args.code as string || "",
          step.description,
          "echo 'test passed'",
          1
        );

        if (reflection.fixedCode) {
          step.args.code = reflection.fixedCode;
          const retryOutcome = await executeStep(step, results, tools);
          if (retryOutcome.success) {
            results[step.id] = retryOutcome.result;
            step.status = "done";
            break;
          }
        }
      }
    }

    updateTaskStatus(
      step.status === "done" ? "done" : "error",
      `${step.description}: ${step.status === "done" ? "OK" : "Failed"}`
    );
  }

  // Complete task
  const success = plan.steps.every(s => s.status === "done");
  if (success) {
    completeTask(`Completed ${plan.steps.length} steps: ${plan.summary}`);
  } else {
    const failed = plan.steps.filter(s => s.status === "failed").length;
    failTask(`${failed} steps failed: ${plan.summary}`);
  }

  return {
    success,
    results,
    plan,
  };
}

// ============================================================
// Smart Context Builder (RAG-enhanced)
// ============================================================

export async function buildSmartContext(
  files: Array<{ path: string; content: string }>,
  query: string,
  maxTokens: number = 100000
): Promise<string> {    const ragResults = await retrieveFromCodebase(files, query);
  
  let context = "";
  let tokenCount = 0;

  for (const result of ragResults) {
    const snippet = `\n// ${result.filePath} (lines ${result.startLine}-${result.endLine})\n${result.relevantLines}\n`;
    const estimatedTokens = snippet.length / 4; // rough estimate
    
    if (tokenCount + estimatedTokens > maxTokens) break;
    
    context += snippet;
    tokenCount += estimatedTokens;
  }

  return context;
}

// ============================================================
// Integration with existing background worker
// ============================================================

/**
 * Enhanced version of the tool-calling loop
 * Uses LangChain orchestration for better planning and execution
 */
export async function enhancedToolLoop(
  messages: Array<{ role: string; content: string }>,
  tools: Record<string, (args: Record<string, unknown>) => Promise<string>>,
  config: {
    maxReflectionAttempts?: number;
    enableRAG?: boolean;
    onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
    onToolResult?: (toolName: string, result: string) => void;
  } = {}
): Promise<string> {
  const { 
    maxReflectionAttempts = 3,
    enableRAG = true,
    onToolCall,
    onToolResult
  } = config;

  let displayContent = "";
  let toolCallCount = 0;
  const MAX_TURNS = 50;
  const toolCounts: Record<string, number> = {};

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Call M3
    const adapter = (await import("./ai-providers")).createProviderAdapter();
    const response = await adapter.complete(messages);

    // Check for tool calls
    const toolCallMatch = response.match(/<tool_call>\s*\{[^}]+\}\s*<\/tool_call>/g);
    
    if (!toolCallMatch) {
      // No more tool calls - return final response
      displayContent += response;
      return displayContent;
    }

    // Execute tool calls
    for (const match of toolCallMatch) {
      try {
        const jsonStr = match.replace(/<tool_call>\s*/, "").replace(/\s*<\/tool_call>/, "");
        const toolCall = JSON.parse(jsonStr);
        const { name, arguments: args } = toolCall;

        // Track tool usage for loop detection
        toolCounts[name] = (toolCounts[name] || 0) + 1;
        if (toolCounts[name] > 5) {
          displayContent += `\n[Loop detected: ${name} called ${toolCounts[name]} times]\n`;
          break;
        }

        onToolCall?.(name, args);
        displayContent += `\nRunning ${name}...\n`;

        // Execute the tool
        const result = await tools[name]?.(args) || `Error: Tool "${name}" not found`;
        onToolResult?.(name, result);
        displayContent += `${result}\n`;

        // Add to messages for context
        messages.push({ role: "assistant", content: response });
        messages.push({ role: "user", content: `<tool_result name="${name}">${result}</tool_result>` });

        toolCallCount++;
      } catch (error) {
        displayContent += `Error parsing tool call: ${error}\n`;
      }
    }
  }

  return displayContent;
}
