/**
 * multi-agent.ts — Multi-Agent Orchestration System
 *
 * Architecture:
 * ┌─────────────────────────────────────────────┐
 * │  COORDINATOR (M3) — Master Orchestrator     │
 * │  Routes tasks to specialized agents         │
 * └─────────────┬───────────────────────────────┘
 *               ↓
 *     ┌─────────┼─────────┬──────────┐
 *     ↓         ↓         ↓          ↓
 * ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────┐
 * │PLANNER │ │CODER   │ │REVIEWER│ │RESEARCHER│
 * │Creates │ │Writes  │ │Reviews │ │Searches  │
 * │plans   │ │code    │ │for bugs│ │web+docs  │
 * └────────┘ └────────┘ └────────┘ └──────────┘
 *
 * All 5 agents use MiniMax M3 — different system prompts, different tools.
 */

import { StateGraph, Annotation, END } from "@langchain/langgraph";

// ============================================================
// M3 Model Wrapper — calls M3 via OpenRouter or NVIDIA
// ============================================================

interface M3Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface M3Response {
  content: string;
  reasoning: string;
  toolCalls: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
}

// Get API key and provider dynamically
function getProviderConfig(): { url: string; key: string; model: string } {
  const nvKey = process.env.NVIDIA_API_KEY || "";

  if (nvKey) {
    return {
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      key: nvKey,
      model: process.env.NVIDIA_MODEL || "minimax/minimax-m3:free",
    };
  }
  throw new Error("No NVIDIA API key configured (NVIDIA_API_KEY)");
}

/**
 * Call M3 with messages — non-streaming, returns full response.
 * Each agent calls this with its own system prompt.
 */
export async function callM3(
  messages: M3Message[],
  maxTokens: number = 4096
): Promise<M3Response> {
  const config = getProviderConfig();

  const res = await fetch(config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.key}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
      stream: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "unknown");
    throw new Error(`M3 API error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error("M3 returned no choices");

  return {
    content: choice.message?.content || "",
    reasoning: choice.message?.reasoning || "",
    toolCalls: choice.message?.tool_calls || [],
  };
}

/**
 * Call M3 with tools — returns full response with tool calls.
 */
export async function callM3WithTools(
  systemPrompt: string,
  messages: M3Message[],
  tools: unknown[],
  maxTokens: number = 4096
): Promise<M3Response> {
  const config = getProviderConfig();

  const res = await fetch(config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.key}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      tools,
      tool_choice: "auto",
      max_tokens: maxTokens,
      temperature: 0.7,
      stream: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "unknown");
    throw new Error(`M3 API error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error("M3 returned no choices");

  return {
    content: choice.message?.content || "",
    reasoning: choice.message?.reasoning || "",
    toolCalls: choice.message?.tool_calls || [],
  };
}

// ============================================================
// Agent System Prompts — Each agent is M3 with a different persona
// ============================================================

const COORDINATOR_PROMPT = `You are the COORDINATOR agent in a multi-agent coding system. Your job is to ROUTE tasks to the right specialist.

You have access to these sub-agents:
- PLANNER: Creates step-by-step execution plans (use for complex tasks)
- CODER: Writes and edits code files (use for implementation)
- REVIEWER: Reviews code for bugs and quality (use after coder finishes)
- RESEARCHER: Searches web and docs for information (use when you need external info)

Your job:
1. Analyze the user's request
2. Decide which agent(s) should handle it
3. Route to the RIGHT agent (you can route to multiple in sequence)

OUTPUT FORMAT (JSON only, no other text):
{"route": "planner", "reason": "complex task needs planning"}
{"route": "coder", "reason": "simple file creation"}
{"route": "researcher", "reason": "need to find API docs"}
{"route": "reviewer", "reason": "code needs review"}
{"route": "direct", "reason": "simple question, no tools needed", "answer": "your answer here"}
{"route": "sequence", "reason": "multi-step task", "steps": ["planner", "coder", "reviewer"]}`;

const PLANNER_PROMPT = `You are the PLANNER agent. Your job is to create detailed execution plans.

When given a task:
1. Break it into specific, actionable steps
2. Each step should be ONE atomic action
3. Specify which tool each step needs
4. Order steps by dependency

OUTPUT FORMAT (JSON only):
{"steps": [{"id": 1, "description": "Read existing files", "tool": "read_file", "args": {"path": "..."}}, {"id": 2, "description": "Create HTML structure", "tool": "write_file", "args": {"path": "index.html", "content": "..."}}, ...], "summary": "Build a 3D BMW website with Three.js", "estimated_turns": 5}

RULES:
- Use write_file_chunk for files > 200 lines
- Use CDN URLs for libraries (Three.js, Tailwind, etc.)
- Plan for error handling and edge cases
- Be specific — no vague steps like "improve the code"`;

const CODER_PROMPT = `You are the CODER agent. Your job is to write and edit code files.

You have these tools:
- write_file: Create or overwrite a file
- write_file_chunk: Append to an existing file (for large files)
- edit_file: Find and replace text in a file
- batch_edit: Edit multiple files at once
- read_file: Read a file before editing
- list_files: See directory structure
- run_command: Execute shell commands
- run_in_sandbox: Run code in a sandbox

RULES:
1. ALWAYS read_file before edit_file
2. Write large files in chunks (200 lines each)
3. Use CDN URLs for libraries, never inline them
4. Add error handling and loading states
5. Follow existing code style
6. Verify with run_command after changes

When given a plan step, execute it precisely. If a step fails, explain why and suggest a fix.`;

const REVIEWER_PROMPT = `You are the CODE REVIEWER agent. Your job is to review code for bugs, security issues, and quality problems.

When given code or a file path:
1. Read the file
2. Analyze for:
   - Runtime errors (null refs, unhandled promises, type mismatches)
   - Security issues (XSS, injection, exposed secrets)
   - Performance problems (N+1 queries, unnecessary re-renders)
   - Code quality (naming, structure, duplication)
   - Missing edge cases
3. Output a structured review

OUTPUT FORMAT (JSON only):
{"issues": [{"severity": "critical|warning|info", "file": "path", "line": 42, "description": "Issue description", "fix": "Suggested fix"}], "score": 8, "summary": "Overall assessment"}

RULES:
- Be specific — cite file paths and line numbers
- Distinguish critical bugs from style suggestions
- Always provide a fix suggestion
- Don't flag intentional patterns as bugs`;

const RESEARCHER_PROMPT = `You are the RESEARCHER agent. Your job is to find information from the web and documentation.

You have these tools:
- web_search: Search the internet
- read_file: Read local files for context

When given a question or topic:
1. Search for relevant documentation
2. Find best practices and examples
3. Check for library versions and compatibility
4. Summarize findings clearly

RULES:
- Always cite sources
- Prioritize official documentation
- Check for version compatibility
- Provide code examples when relevant
- Be concise — no filler`;

// ============================================================
// Tool Definitions for each agent
// ============================================================

const COMMON_TOOLS = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file_chunk",
      description: "Append content to an existing file (for large files)",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Find and replace text in a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file's contents",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files in a directory",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Execute a shell command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
];

const RESEARCH_TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the internet",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file's contents",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
];

// ============================================================
// LangGraph State — connects all agents
// ============================================================

interface AgentState {
  userRequest: string;
  coordinatorDecision: string;
  plan: string;
  codeOutput: string;
  reviewResult: string;
  researchResult: string;
  finalAnswer: string;
  currentAgent: string;
  turnCount: number;
  error: string;
}

const AgentStateAnnotation = Annotation.Root({
  userRequest: Annotation<string>,
  coordinatorDecision: Annotation<string>,
  plan: Annotation<string>,
  codeOutput: Annotation<string>,
  reviewResult: Annotation<string>,
  researchResult: Annotation<string>,
  finalAnswer: Annotation<string>,
  currentAgent: Annotation<string>,
  turnCount: Annotation<number>,
  error: Annotation<string>,
});

// ============================================================
// Agent Nodes — each calls M3 with its own prompt
// ============================================================

async function coordinatorNode(state: AgentState): Promise<Partial<AgentState>> {
  console.log("[COORDINATOR] Routing:", state.userRequest.slice(0, 100));

  const response = await callM3([
    { role: "system", content: COORDINATOR_PROMPT },
    { role: "user", content: state.userRequest },
  ]);

  return {
    coordinatorDecision: response.content,
    currentAgent: "coordinator",
    turnCount: state.turnCount + 1,
  };
}

async function plannerNode(state: AgentState): Promise<Partial<AgentState>> {
  console.log("[PLANNER] Creating plan for:", state.userRequest.slice(0, 100));

  const response = await callM3([
    { role: "system", content: PLANNER_PROMPT },
    { role: "user", content: `Create a plan for: ${state.userRequest}\n\nContext: ${state.coordinatorDecision}` },
  ]);

  return {
    plan: response.content,
    currentAgent: "planner",
    turnCount: state.turnCount + 1,
  };
}

async function coderNode(state: AgentState): Promise<Partial<AgentState>> {
  console.log("[CODER] Executing plan");

  const context = state.plan || state.userRequest;
  const response = await callM3WithTools(
    CODER_PROMPT,
    [{ role: "user", content: `Execute this plan:\n${context}\n\nUser request: ${state.userRequest}` }],
    COMMON_TOOLS,
    4096
  );

  return {
    codeOutput: response.content,
    currentAgent: "coder",
    turnCount: state.turnCount + 1,
  };
}

async function reviewerNode(state: AgentState): Promise<Partial<AgentState>> {
  console.log("[REVIEWER] Reviewing code");

  const response = await callM3WithTools(
    REVIEWER_PROMPT,
    [{ role: "user", content: `Review this code output:\n${state.codeOutput}\n\nPlan was: ${state.plan}` }],
    COMMON_TOOLS.slice(0, 2), // read_file + list_files only
    2048
  );

  return {
    reviewResult: response.content,
    currentAgent: "reviewer",
    turnCount: state.turnCount + 1,
  };
}

async function researcherNode(state: AgentState): Promise<Partial<AgentState>> {
  console.log("[RESEARCHER] Searching for info");

  const response = await callM3WithTools(
    RESEARCHER_PROMPT,
    [{ role: "user", content: state.userRequest }],
    RESEARCH_TOOLS,
    2048
  );

  return {
    researchResult: response.content,
    currentAgent: "researcher",
    turnCount: state.turnCount + 1,
  };
}

// ============================================================
// Routing Logic — Coordinator decides which agent runs next
// ============================================================

function routeFromCoordinator(state: AgentState): string {
  try {
    const decision = JSON.parse(state.coordinatorDecision);
    const route = decision.route;

    if (route === "direct") return "end";
    if (route === "planner") return "planner";
    if (route === "coder") return "coder";
    if (route === "reviewer") return "reviewer";
    if (route === "researcher") return "researcher";
    if (route === "sequence") return "planner"; // Start with planner
    return "end";
  } catch {
    return "end";
  }
}

function routeAfterPlanner(state: AgentState): string {
  return "coder"; // After planning, always code
}

function routeAfterCoder(state: AgentState): string {
  try {
    const decision = JSON.parse(state.coordinatorDecision);
    if (decision.route === "sequence" && decision.steps?.includes("reviewer")) {
      return "reviewer";
    }
  } catch {}
  return "end";
}

function routeAfterResearcher(state: AgentState): string {
  return "end"; // After research, return to user
}

// ============================================================
// Build the LangGraph State Machine
// ============================================================

function buildAgentGraph() {
  const graph = new StateGraph(AgentStateAnnotation)
    .addNode("coordinator", coordinatorNode)
    .addNode("planner", plannerNode)
    .addNode("coder", coderNode)
    .addNode("reviewer", reviewerNode)
    .addNode("researcher", researcherNode)
    .addEdge("__start__", "coordinator")
    .addConditionalEdges("coordinator", routeFromCoordinator, {
      planner: "planner",
      coder: "coder",
      reviewer: "reviewer",
      researcher: "researcher",
      end: END,
    })
    .addConditionalEdges("planner", routeAfterPlanner, {
      coder: "coder",
    })
    .addConditionalEdges("coder", routeAfterCoder, {
      reviewer: "reviewer",
      end: END,
    })
    .addConditionalEdges("researcher", routeAfterResearcher, {
      end: END,
    })
    .addEdge("reviewer", END);

  return graph.compile();
}

// ============================================================
// Public API — run the multi-agent system
// ============================================================

export interface MultiAgentResult {
  finalAnswer: string;
  coordinatorDecision: string;
  plan: string;
  codeOutput: string;
  reviewResult: string;
  researchResult: string;
  agentsUsed: string[];
  turnCount: number;
}

let compiledGraph: ReturnType<typeof buildAgentGraph> | null = null;

function getGraph() {
  if (!compiledGraph) {
    compiledGraph = buildAgentGraph();
  }
  return compiledGraph;
}

/**
 * Run the multi-agent system on a user request.
 * Returns the combined output from all agents.
 */
export async function runMultiAgent(
  userRequest: string
): Promise<MultiAgentResult> {
  console.log(`[MULTI-AGENT] Starting: ${userRequest.slice(0, 100)}`);
  const startTime = Date.now();

  const graph = getGraph();

  const initialState: AgentState = {
    userRequest,
    coordinatorDecision: "",
    plan: "",
    codeOutput: "",
    reviewResult: "",
    researchResult: "",
    finalAnswer: "",
    currentAgent: "",
    turnCount: 0,
    error: "",
  };

  try {
    const result = await graph.invoke(initialState);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Determine which agents were used
    const agentsUsed: string[] = [];
    if (result.coordinatorDecision) agentsUsed.push("coordinator");
    if (result.plan) agentsUsed.push("planner");
    if (result.codeOutput) agentsUsed.push("coder");
    if (result.reviewResult) agentsUsed.push("reviewer");
    if (result.researchResult) agentsUsed.push("researcher");

    // Build final answer from all agent outputs
    const parts: string[] = [];
    if (result.plan) {
      try {
        const plan = JSON.parse(result.plan);
        parts.push(`## Plan\n${plan.summary || "Plan created"}\n\nSteps: ${plan.steps?.length || 0}`);
      } catch {
        parts.push(`## Plan\n${result.plan.slice(0, 500)}`);
      }
    }
    if (result.codeOutput) parts.push(`## Code\n${result.codeOutput.slice(0, 2000)}`);
    if (result.reviewResult) {
      try {
        const review = JSON.parse(result.reviewResult);
        parts.push(`## Review (Score: ${review.score}/10)\n${review.issues?.length || 0} issues found`);
      } catch {
        parts.push(`## Review\n${result.reviewResult.slice(0, 500)}`);
      }
    }
    if (result.researchResult) parts.push(`## Research\n${result.researchResult.slice(0, 1000)}`);

    console.log(`[MULTI-AGENT] Done in ${elapsed}s — agents: ${agentsUsed.join(", ")}`);

    return {
      finalAnswer: parts.join("\n\n") || "Task completed.",
      coordinatorDecision: result.coordinatorDecision,
      plan: result.plan,
      codeOutput: result.codeOutput,
      reviewResult: result.reviewResult,
      researchResult: result.researchResult,
      agentsUsed,
      turnCount: result.turnCount,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[MULTI-AGENT] Error: ${msg}`);
    return {
      finalAnswer: `Error: ${msg}`,
      coordinatorDecision: "",
      plan: "",
      codeOutput: "",
      reviewResult: "",
      researchResult: "",
      agentsUsed: [],
      turnCount: 0,
    };
  }
}
