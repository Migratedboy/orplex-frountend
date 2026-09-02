/**
 * langchain-orchestrator.ts
 * 
 * Plan-and-Execute agent architecture using LangGraph.js
 * Makes M3 smarter by:
 * 1. Planning once, executing steps in parallel
 * 2. Self-correcting via reflection loop
 * 3. Retrieving only relevant code via RAG
 */

import { Annotation } from "@langchain/langgraph";

// ============================================================
// Types
// ============================================================

export interface PlanStep {
  id: number;
  description: string;
  tool: string;
  args: Record<string, unknown>;
  status: "pending" | "running" | "done" | "failed";
  result?: string;
  dependencies?: number[]; // Steps that must complete before this one
}

export interface ExecutionPlan {
  steps: PlanStep[];
  summary: string;
  estimatedTurns: number;
}

// Helper to call the AI model
async function callModel(messages: { role: string; content: string }[]): Promise<string> {
  const adapter = (await import("./ai-providers")).createProviderAdapter();
  return adapter.complete(messages);
}

export interface ReflectionResult {
  success: boolean;
  code?: string;
  error?: string;
  attempts: number;
  fixedCode?: string;
}



export interface RAGResult {
  filePath: string;
  relevantLines: string;
  startLine: number;
  endLine: number;
  score: number;
}

// ============================================================
// State Graph Annotation
// ============================================================

const AgentState = Annotation.Root({
  messages: Annotation<{ role: string; content: string }[]>({
    reducer: (curr, prev) => [...curr, ...prev],
    default: () => [],
  }),
  plan: Annotation<ExecutionPlan | null>({
    reducer: (_, prev) => prev,
    default: () => null,
  }),
  currentStep: Annotation<number>({
    reducer: (_, prev) => prev,
    default: () => 0,
  }),
  results: Annotation<Record<number, string>>({
    reducer: (curr, prev) => ({ ...curr, ...prev }),
    default: () => ({}),
  }),
  reflectionAttempts: Annotation<number>({
    reducer: (_, prev) => prev,
    default: () => 0,
  }),
  isComplete: Annotation<boolean>({
    reducer: (_, prev) => prev,
    default: () => false,
  }),
});

// ============================================================
// PLANNER: Creates execution plan from user request
// ============================================================

export async function createPlan(
  userRequest: string,
  availableTools: string[],
  existingCode?: string
): Promise<ExecutionPlan> {
  const toolList = availableTools.join(", ");
  
  const systemPrompt = `You are a planning agent. Given a user request, create a step-by-step execution plan.

Available tools: ${toolList}

Rules:
1. Each step should use ONE tool
2. Steps can have dependencies (must run after other steps)
3. Independent steps should run in parallel
4. Be specific about file paths and code changes
5. Estimate how many tool turns each step needs

Return a JSON plan with this exact structure:
{
  "steps": [
    {
      "id": 1,
      "description": "Read the existing auth files",
      "tool": "read_file",
      "args": {"path": "src/auth/login.ts"},
      "dependencies": []
    }
  ],
  "summary": "Fix the login bug by reading auth files, identifying the issue, and applying a fix",
  "estimatedTurns": 6
}`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `User request: ${userRequest}${existingCode ? `\n\nExisting code context:\n${existingCode}` : ""}` },
  ];

  let response = "";
  try {
    response = await callModel(messages);
  } catch (err) {
    console.error("Plan creation failed:", err);
    return { steps: [], summary: "Failed to create plan", estimatedTurns: 3 };
  }
  
  // Parse the plan from the response
  try {
    // Extract JSON from the response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const plan = JSON.parse(jsonMatch[0]) as ExecutionPlan;
      return plan;
    }
  } catch {
    // Fallback: create a simple plan
  }

  // Fallback plan if parsing fails
  return {
    steps: [
      {
        id: 1,
        description: `Execute: ${userRequest}`,
        tool: "read_file",
        args: { path: "." },
        status: "pending",
      },
    ],
    summary: userRequest,
    estimatedTurns: 3,
  };
}

// ============================================================
// EXECUTOR: Runs a single plan step
// ============================================================

export async function executeStep(
  step: PlanStep,
  previousResults: Record<number, string>,
  tools: Record<string, (args: Record<string, unknown>) => Promise<string>>
): Promise<{ stepId: number; result: string; success: boolean }> {
  try {
    // Resolve dependencies - replace references in args with actual results
    const resolvedArgs = { ...step.args };
    if (step.dependencies) {
      for (const depId of step.dependencies) {
        const depResult = previousResults[depId];
        if (depResult) {
          // Replace ${depId} references in args with actual results
          for (const [key, value] of Object.entries(resolvedArgs)) {
            if (typeof value === "string" && value.includes(`\${${depId}}`)) {
              resolvedArgs[key] = value.replace(`\${${depId}}`, depResult);
            }
          }
        }
      }
    }

    // Execute the tool
    const toolFn = tools[step.tool];
    if (!toolFn) {
      return {
        stepId: step.id,
        result: `Error: Tool "${step.tool}" not found`,
        success: false,
      };
    }

    const result = await toolFn(resolvedArgs);
    return { stepId: step.id, result, success: true };
  } catch (error) {
    return {
      stepId: step.id,
      result: `Error: ${error instanceof Error ? error.message : String(error)}`,
      success: false,
    };
  }
}

// ============================================================
// REFLECTOR: Reviews code and suggests fixes
// ============================================================

export async function reflectOnCode(
  code: string,
  error: string,
  task: string
): Promise<ReflectionResult> {
  const systemPrompt = `You are a code reviewer. A developer wrote code for a task, but it has errors.

Your job:
1. Analyze the error
2. Identify the root cause in the code
3. Provide the corrected code
4. Explain what was wrong

Return JSON:
{
  "success": true/false,
  "fixedCode": "the corrected code here",
  "error": "what was wrong",
  "explanation": "why it was wrong and how you fixed it"
}`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Task: ${task}\n\nCode with error:\n${code}\n\nError:\n${error}` },
  ];

  let response = "";
  try {
    response = await callModel(messages);
  } catch (err) {
    console.error("Reflection failed:", err);
    return { success: false, error: "Reflection failed", attempts: 1 };
  }

  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return {
        success: result.success ?? false,
        fixedCode: result.fixedCode,
        error: result.error,
        attempts: 1,
      };
    }
  } catch {
    // Fallback
  }

  return {
    success: false,
    error: "Failed to parse reflection result",
    attempts: 1,
  };
}

// ============================================================
// REFLECTION LOOP: Auto-fix code until it works
// ============================================================

export async function reflectionLoop(
  code: string,
  task: string,
  testCommand: string,
  maxAttempts: number = 3
): Promise<ReflectionResult> {
  let currentCode = code;
  let lastError = "";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Run the test
    try {
      const { execSync } = require("child_process");
      execSync(testCommand, { 
        timeout: 30000, 
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"]
      });
      
      // Test passed
      return {
        success: true,
        code: currentCode,
        attempts: attempt + 1,
      };
    } catch (testError: unknown) {
      const err = testError as { stderr?: string; stdout?: string; message?: string };
      lastError = err.stderr || err.stdout || err.message || String(testError);
    }

    // Reflect on the error
    const reflection = await reflectOnCode(currentCode, lastError, task);
    
    if (reflection.fixedCode) {
      currentCode = reflection.fixedCode;
    } else {
      break;
    }
  }

  return {
    success: false,
    code: currentCode,
    error: lastError,
    attempts: maxAttempts,
  };
}

// ============================================================
// RAG: Retrieve relevant code snippets
// ============================================================

/**
 * Simple keyword-based code retrieval (no embeddings needed)
 * Finds the most relevant lines in a file for a given query
 */
export function retrieveRelevantCode(
  fileContent: string,
  query: string,
  maxLines: number = 50
): RAGResult[] {
  const lines = fileContent.split("\n");
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  
  const scoredLines: Array<{ line: number; score: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    let score = 0;

    for (const term of queryTerms) {
      if (lineLower.includes(term)) {
        score += 1;
        // Bonus for exact word match
        if (lineLower.split(/\s+/).includes(term)) {
          score += 0.5;
        }
      }
    }

    // Bonus for function/class definitions
    if (lines[i].match(/(function|class|export|import|const\s+\w+\s*=)/)) {
      score += 0.3;
    }

    if (score > 0) {
      scoredLines.push({ line: i, score });
    }
  }

  // Sort by score and take top matches
  scoredLines.sort((a, b) => b.score - a.score);
  const topMatches = scoredLines.slice(0, Math.ceil(maxLines / 10));

  // Group nearby lines into snippets
  const results: RAGResult[] = [];
  const used = new Set<number>();

  for (const match of topMatches) {
    if (used.has(match.line)) continue;

    // Get context window around the match
    const start = Math.max(0, match.line - 5);
    const end = Math.min(lines.length - 1, match.line + 5);
    
    const relevantLines = lines.slice(start, end + 1).join("\n");
    
    results.push({
      filePath: "",
      relevantLines,
      startLine: start + 1,
      endLine: end + 1,
      score: match.score,
    });

    for (let i = start; i <= end; i++) used.add(i);
  }

  return results.slice(0, 5); // Max 5 snippets
}

/**
 * Multi-file RAG: Search across multiple files for relevant code
 */
export async function retrieveFromCodebase(
  files: Array<{ path: string; content: string }>,
  query: string
): Promise<Array<RAGResult & { filePath: string }>> {
  const allResults: Array<RAGResult & { filePath: string }> = [];

  for (const file of files) {
    const results = retrieveRelevantCode(file.content, query);
    for (const result of results) {
      allResults.push({ ...result, filePath: file.path });
    }
  }

  // Sort by score and return top 10
  allResults.sort((a, b) => b.score - a.score);
  return allResults.slice(0, 10);
}

// ============================================================
// MAIN ORCHESTRATOR: Ties everything together
// ============================================================

export interface OrchestratorConfig {
  maxReflectionAttempts?: number;
  parallelExecution?: boolean;
  ragEnabled?: boolean;
  onStepComplete?: (step: PlanStep, result: string) => void;
  onReflection?: (attempt: number, error: string) => void;
}

/**
 * Main orchestrator function
 * Plans → Executes (with RAG) → Reflects → Verifies
 */
export async function orchestrate(
  userRequest: string,
  tools: Record<string, (args: Record<string, unknown>) => Promise<string>>,
  existingFiles?: Array<{ path: string; content: string }>,
  config: OrchestratorConfig = {}
): Promise<{
  success: boolean;
  results: Record<number, string>;
  plan: ExecutionPlan;
  totalSteps: number;
  completedSteps: number;
}> {
  const {
    maxReflectionAttempts = 3,
    parallelExecution = true,
    ragEnabled = true,
    onStepComplete,
    onReflection,
  } = config;

  // Step 1: Create plan
  const toolNames = Object.keys(tools);
  let context = "";
  
  if (ragEnabled && existingFiles) {
    // Use RAG to get relevant context
    const ragResults = await retrieveFromCodebase(existingFiles, userRequest);
    if (ragResults.length > 0) {
      context = "\n\nRelevant code context:\n" + ragResults
        .map(r => `// ${r.filePath} (lines ${r.startLine}-${r.endLine})\n${r.relevantLines}`)
        .join("\n\n");
    }
  }

  const plan = await createPlan(userRequest, toolNames, context);

  // Step 2: Execute steps (parallel where possible)
  const results: Record<number, string> = {};
  const completedSteps = new Set<number>();

  // Group steps by dependencies for parallel execution
  const getReadySteps = (): PlanStep[] => {
    return plan.steps.filter(step => {
      if (completedSteps.has(step.id)) return false;
      if (step.status !== "pending") return false;
      // Check if all dependencies are completed
      if (step.dependencies) {
        return step.dependencies.every(depId => completedSteps.has(depId));
      }
      return true;
    });
  };

  let iterations = 0;
  const maxIterations = plan.steps.length * 2;

  while (completedSteps.size < plan.steps.length && iterations < maxIterations) {
    iterations++;
    const readySteps = getReadySteps();

    if (readySteps.length === 0) {
      // Deadlock or all remaining steps have failed dependencies
      break;
    }

    if (parallelExecution && readySteps.length > 1) {
      // Execute steps in parallel
      const promises = readySteps.map(step => {
        step.status = "running";
        return executeStep(step, results, tools);
      });

      const outcomes = await Promise.all(promises);
      
      for (const outcome of outcomes) {
        const step = plan.steps.find(s => s.id === outcome.stepId);
        if (step) {
          step.status = outcome.success ? "done" : "failed";
          results[outcome.stepId] = outcome.result;
          completedSteps.add(outcome.stepId);
          onStepComplete?.(step, outcome.result);
        }
      }
    } else {
      // Execute steps sequentially
      const step = readySteps[0];
      step.status = "running";
      const outcome = await executeStep(step, results, tools);
      
      step.status = outcome.success ? "done" : "failed";
      results[outcome.stepId] = outcome.result;
      completedSteps.add(outcome.stepId);
      onStepComplete?.(step, outcome.result);

      // Reflection on failure
      if (!outcome.success && outcome.result.includes("Error")) {
        for (let attempt = 0; attempt < maxReflectionAttempts; attempt++) {
          onReflection?.(attempt + 1, outcome.result);
          
          const reflection = await reflectOnCode(
            step.args.code as string || "",
            outcome.result,
            step.description
          );

          if (reflection.fixedCode) {
            // Retry with fixed code
            step.args.code = reflection.fixedCode;
            step.status = "running";
            const retryOutcome = await executeStep(step, results, tools);
            
            if (retryOutcome.success) {
              step.status = "done";
              results[retryOutcome.stepId] = retryOutcome.result;
              break;
            }
          }
        }
      }
    }
  }

  return {
    success: completedSteps.size === plan.steps.length,
    results,
    plan,
    totalSteps: plan.steps.length,
    completedSteps: completedSteps.size,
  };
}
