/**
 * swarm.ts — Swarm Coordination System
 *
 * Inspired by Ruflo's swarm architecture:
 * - Mesh: All agents communicate equally
 * - Hierarchical: Queen → Workers
 * - Pipeline: Linear chain with feedback loops
 *
 * Key feature: Parallel execution of independent tasks
 */

import { callM3, callM3WithTools } from "./multi-agent";

// ============================================================
// Types
// ============================================================

export type Topology = "mesh" | "hierarchical" | "pipeline";

export interface SwarmAgent {
  id: string;
  role: "coordinator" | "planner" | "coder" | "reviewer" | "researcher" | "tester" | "security";
  systemPrompt: string;
  tools: unknown[];
  maxTokens: number;
  status: "idle" | "working" | "done" | "error";
  lastOutput: string;
  tokenUsage: number;
}

export interface SwarmTask {
  id: string;
  description: string;
  assignedTo: string[];
  dependencies: string[]; // task IDs that must complete first
  status: "pending" | "running" | "done" | "failed";
  result?: string;
  retries: number;
}

export interface SwarmConfig {
  topology: Topology;
  maxConcurrent: number;      // Max parallel agents (default: 4)
  maxRetries: number;         // Retries per failed task
  consensusThreshold: number; // % of agents that must agree (for review)
  timeoutMs: number;          // Per-agent timeout
}

export interface SwarmResult {
  taskId: string;
  agentId: string;
  success: boolean;
  output: string;
  duration: number;
  tokens: number;
}

// ============================================================
// Agent Definitions — specialized agents for the swarm
// ============================================================

const AGENT_DEFINITIONS: Record<string, Omit<SwarmAgent, "id" | "status" | "lastOutput" | "tokenUsage">> = {
  coder: {
    role: "coder",
    systemPrompt: `You are a CODER agent in a swarm. You write production-ready code.
- Write clean, typed TypeScript
- Include error handling
- Follow existing code conventions
- Output ONLY the code, no explanations
- Use write_file tool to create files`,
    tools: [
      { type: "function", function: { name: "write_file", description: "Create a file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
      { type: "function", function: { name: "edit_file", description: "Edit a file", parameters: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } } },
      { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
    ],
    maxTokens: 16384,
  },
  reviewer: {
    role: "reviewer",
    systemPrompt: `You are a CODE REVIEWER agent. Review code for bugs, security, and quality.
Output a JSON review:
{"issues": [{"severity": "critical|warning|info", "file": "path", "line": 42, "description": "...", "fix": "..."}], "score": 8, "summary": "..."}`,
    tools: [
      { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
      { type: "function", function: { name: "list_files", description: "List files", parameters: { type: "object", properties: { path: { type: "string" } } } } },
    ],
    maxTokens: 4096,
  },
  tester: {
    role: "tester",
    systemPrompt: `You are a TESTER agent. Write and run tests.
- Analyze the code and write unit tests
- Use the test framework the project uses
- Output test file paths and results`,
    tools: [
      { type: "function", function: { name: "write_file", description: "Create a test file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
      { type: "function", function: { name: "run_command", description: "Run tests", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
      { type: "function", function: { name: "read_file", description: "Read source file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
    ],
    maxTokens: 8192,
  },
  security: {
    role: "security",
    systemPrompt: `You are a SECURITY agent. Scan code for vulnerabilities.
Check for: XSS, injection, exposed secrets, insecure patterns, missing auth.
Output JSON: {"vulnerabilities": [{"severity": "critical|high|medium|low", "type": "...", "file": "...", "description": "...", "fix": "..."}]}`,
    tools: [
      { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
      { type: "function", function: { name: "list_files", description: "List files", parameters: { type: "object", properties: { path: { type: "string" } } } } },
    ],
    maxTokens: 4096,
  },
  researcher: {
    role: "researcher",
    systemPrompt: `You are a RESEARCHER agent. Find information from the web.
Search for documentation, best practices, and examples.
Return concise summaries with sources.`,
    tools: [
      { type: "function", function: { name: "web_search", description: "Search the web", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
    ],
    maxTokens: 4096,
  },
};

// ============================================================
// Swarm Engine
// ============================================================

export class Swarm {
  private agents: Map<string, SwarmAgent> = new Map();
  private tasks: Map<string, SwarmTask> = new Map();
  private config: SwarmConfig;
  private results: SwarmResult[] = [];

  constructor(config: Partial<SwarmConfig> = {}) {
    this.config = {
      topology: config.topology || "hierarchical",
      maxConcurrent: config.maxConcurrent || 4,
      maxRetries: config.maxRetries || 2,
      consensusThreshold: config.consensusThreshold || 0.6,
      timeoutMs: config.timeoutMs || 60000,
    };
  }

  // --- Agent Management ---

  spawnAgent(role: string, id?: string): SwarmAgent {
    const def = AGENT_DEFINITIONS[role];
    if (!def) throw new Error(`Unknown agent role: ${role}`);

    const agent: SwarmAgent = {
      id: id || `${role}-${Date.now()}`,
      ...def,
      status: "idle",
      lastOutput: "",
      tokenUsage: 0,
    };
    this.agents.set(agent.id, agent);
    return agent;
  }

  spawnSwarm(roles: string[]): SwarmAgent[] {
    return roles.map(role => this.spawnAgent(role));
  }

  // --- Task Management ---

  createTask(description: string, assignedTo: string[], dependencies: string[] = []): SwarmTask {
    const task: SwarmTask = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      description,
      assignedTo,
      dependencies,
      status: "pending",
      retries: 0,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  // --- Parallel Execution ---

  private async executeAgent(agent: SwarmAgent, task: SwarmTask): Promise<SwarmResult> {
    const start = Date.now();
    agent.status = "working";

    try {
      const response = await callM3WithTools(
        agent.systemPrompt,
        [{ role: "user", content: task.description }],
        agent.tools,
        agent.maxTokens
      );

      agent.status = "done";
      agent.lastOutput = response.content;

      return {
        taskId: task.id,
        agentId: agent.id,
        success: true,
        output: response.content,
        duration: Date.now() - start,
        tokens: response.content.length / 4, // rough estimate
      };
    } catch (err) {
      agent.status = "error";
      return {
        taskId: task.id,
        agentId: agent.id,
        success: false,
        output: (err as Error).message,
        duration: Date.now() - start,
        tokens: 0,
      };
    }
  }

  /**
   * Execute tasks in parallel, respecting dependencies and concurrency limits.
   */
  async executeParallel(): Promise<SwarmResult[]> {
    const allTasks = Array.from(this.tasks.values());
    const completed = new Set<string>();
    const running = new Map<string, Promise<SwarmResult>>();
    this.results = [];

    while (completed.size < allTasks.length) {
      // Find tasks whose dependencies are all completed
      const ready = allTasks.filter(t =>
        t.status === "pending" &&
        t.dependencies.every(dep => completed.has(dep))
      );

      if (ready.length === 0 && running.size === 0) {
        // Deadlock — remaining tasks have unresolvable dependencies
        break;
      }

      // Start tasks up to concurrency limit
      for (const task of ready) {
        if (running.size >= this.config.maxConcurrent) break;

        // Pick the first available agent for this task
        const agentId = task.assignedTo.find(id => {
          const agent = this.agents.get(id);
          return agent && agent.status === "idle";
        });

        if (!agentId) continue;
        const agent = this.agents.get(agentId)!;

        task.status = "running";
        const promise = this.executeAgent(agent, task).then(result => {
          task.status = result.success ? "done" : "failed";
          task.result = result.output;
          completed.add(task.id);
          running.delete(task.id);
          this.results.push(result);
          return result;
        });

        running.set(task.id, promise);
      }

      // Wait for at least one to finish
      if (running.size > 0) {
        await Promise.race(running.values());
      }
    }

    return this.results;
  }

  // --- Consensus (for reviews) ---

  /**
   * Run the same review task on multiple agents and check consensus.
   */
  async consensusReview(
    reviewTask: string,
    agentRoles: string[] = ["reviewer", "security"]
  ): Promise<{
    consensus: boolean;
    agreement: number;
    reviews: string[];
    combinedIssues: string[];
  }> {
    const agents = agentRoles.map(role => this.spawnAgent(role));
    const reviews = await Promise.all(
      agents.map(agent => this.executeAgent(agent, {
        id: `review-${Date.now()}`,
        description: reviewTask,
        assignedTo: [agent.id],
        dependencies: [],
        status: "pending",
        retries: 0,
      }))
    );

    const successfulReviews = reviews.filter(r => r.success);
    const agreement = successfulReviews.length / agents.length;

    // Parse issues from each review
    const allIssues: string[] = [];
    for (const review of successfulReviews) {
      try {
        const parsed = JSON.parse(review.output);
        if (parsed.issues) allIssues.push(...parsed.issues.map((i: any) => i.description));
        if (parsed.vulnerabilities) allIssues.push(...parsed.vulnerabilities.map((v: any) => v.description));
      } catch {
        // Raw text review
        allIssues.push(review.output.slice(0, 200));
      }
    }

    return {
      consensus: agreement >= this.config.consensusThreshold,
      agreement,
      reviews: successfulReviews.map(r => r.output),
      combinedIssues: [...new Set(allIssues)],
    };
  }

  // --- Stats ---

  getStats(): {
    agents: number;
    tasks: { total: number; done: number; failed: number };
    totalTokens: number;
    avgDuration: number;
  } {
    const agentArray = Array.from(this.agents.values());
    const taskArray = Array.from(this.tasks.values());
    return {
      agents: agentArray.length,
      tasks: {
        total: taskArray.length,
        done: taskArray.filter(t => t.status === "done").length,
        failed: taskArray.filter(t => t.status === "failed").length,
      },
      totalTokens: this.results.reduce((s, r) => s + r.tokens, 0),
      avgDuration: this.results.length > 0
        ? this.results.reduce((s, r) => s + r.duration, 0) / this.results.length
        : 0,
    };
  }

  // --- Cleanup ---

  reset(): void {
    this.agents.clear();
    this.tasks.clear();
    this.results = [];
  }
}

// ============================================================
// Convenience Functions
// ============================================================

/**
 * Run a multi-file coding task with parallel agents.
 * Coder writes files, reviewer checks them, tester writes tests — all in parallel where possible.
 */
export async function swarmCodeAndReview(
  task: string,
  fileContext: string = ""
): Promise<{
  code: string;
  review: string;
  tests: string;
  consensus: boolean;
}> {
  const swarm = new Swarm({ topology: "hierarchical", maxConcurrent: 3 });

  // Spawn agents
  const coder = swarm.spawnAgent("coder");
  const reviewer = swarm.spawnAgent("reviewer");
  const tester = swarm.spawnAgent("tester");

  // Create tasks with dependencies
  const codeTask = swarm.createTask(
    `Write code for: ${task}\n\nContext:\n${fileContext}`,
    [coder.id]
  );
  const reviewTask = swarm.createTask(
    `Review the code output from the coder agent for: ${task}`,
    [reviewer.id],
    [codeTask.id] // Depends on coder finishing
  );
  const testTask = swarm.createTask(
    `Write tests for: ${task}`,
    [tester.id],
    [codeTask.id] // Depends on coder finishing, runs parallel with reviewer
  );

  // Execute: coder first, then reviewer + tester in parallel
  await swarm.executeParallel();

  return {
    code: coder.lastOutput,
    review: reviewer.lastOutput,
    tests: tester.lastOutput,
    consensus: reviewer.lastOutput.includes("\"score\": 8") || reviewer.lastOutput.includes("\"score\": 9") || reviewer.lastOutput.includes("\"score\": 10"),
  };
}

/**
 * Quick parallel research: multiple agents search different sources simultaneously.
 */
export async function swarmResearch(
  topic: string,
  angles: string[] = ["documentation", "best practices", "examples"]
): Promise<string[]> {
  const swarm = new Swarm({ topology: "mesh", maxConcurrent: angles.length });

  const agents = angles.map((angle, i) => {
    const agent = swarm.spawnAgent("researcher", `researcher-${i}`);
    swarm.createTask(
      `Research "${topic}" focusing on ${angle}. Find relevant documentation, examples, and best practices.`,
      [agent.id]
    );
    return agent;
  });

  await swarm.executeParallel();
  return agents.map(a => a.lastOutput);
}
