/**
 * sparc.ts — SPARC Development Methodology
 *
 * 5-phase structured development with quality gates:
 *   S — Specification: Extract requirements from user prompt
 *   P — Pseudocode: Write high-level logic and data flow
 *   A — Architecture: Design file structure and dependencies
 *   R — Refinement: Implement code with tool calls
 *   C — Completion: Test, polish, and verify
 *
 * Each phase has a quality gate that must pass before advancing.
 * Based on Ruflo's SPARC methodology that enforces disciplined AI-assisted development.
 */

import { callM3, callM3WithTools } from "./multi-agent";

// ============================================================
// Types
// ============================================================

export type SPARCPhase = "specification" | "pseudocode" | "architecture" | "refinement" | "completion";

export interface PhaseResult {
  phase: SPARCPhase;
  success: boolean;
  output: string;
  gateCheck: GateCheck;
  duration: number;
}

export interface GateCheck {
  passed: boolean;
  criteria: GateCriteria[];
  score: number; // 0-100
}

export interface GateCriteria {
  name: string;
  met: boolean;
  detail: string;
}

export interface SPARCTask {
  id: string;
  userRequest: string;
  phases: PhaseResult[];
  currentPhase: SPARCPhase;
  status: "running" | "completed" | "failed" | "blocked";
  totalDuration: number;
}

// ============================================================
// Phase 1: Specification
// ============================================================

async function runSpecification(userRequest: string): Promise<PhaseResult> {
  const start = Date.now();

  const systemPrompt = `You are a requirements analyst. Extract clear, actionable specifications from the user's request.

Return JSON:
{
  "goal": "One-sentence summary of what to build",
  "requirements": [
    {"id": "R1", "description": "Specific requirement", "priority": "must|should|nice"}
  ],
  "constraints": ["Tech stack constraints", "Performance requirements"],
  "acceptanceCriteria": ["How to verify it works"],
  "estimatedFiles": 5,
  "complexity": "low|medium|high"
}`;

  const response = await callM3([
    { role: "system", content: systemPrompt },
    { role: "user", content: userRequest },
  ], 4096);

  let spec: any;
  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    spec = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch {
    spec = null;
  }

  // Gate check: specification must have requirements and acceptance criteria
  const criteria: GateCriteria[] = [
    { name: "Has goal", met: !!spec?.goal, detail: spec?.goal ? "Goal defined" : "Missing goal" },
    { name: "Has requirements", met: Array.isArray(spec?.requirements) && spec.requirements.length > 0, detail: `${spec?.requirements?.length || 0} requirements found` },
    { name: "Has acceptance criteria", met: Array.isArray(spec?.acceptanceCriteria) && spec.acceptanceCriteria.length > 0, detail: `${spec?.acceptanceCriteria?.length || 0} criteria defined` },
    { name: "Has constraints", met: Array.isArray(spec?.constraints) && spec.constraints.length > 0, detail: `${spec?.constraints?.length || 0} constraints defined` },
  ];

  const passed = criteria.filter(c => c.met).length >= 3;
  const score = Math.round((criteria.filter(c => c.met).length / criteria.length) * 100);

  return {
    phase: "specification",
    success: passed,
    output: response.content,
    gateCheck: { passed, criteria, score },
    duration: Date.now() - start,
  };
}

// ============================================================
// Phase 2: Pseudocode
// ============================================================

async function runPseudocode(specification: string, userRequest: string): Promise<PhaseResult> {
  const start = Date.now();

  const systemPrompt = `You are a software architect. Given a specification, write pseudocode for the implementation.

Return JSON:
{
  "modules": [
    {
      "name": "ModuleName",
      "purpose": "What it does",
      "methods": ["methodName(args) → returnType"],
      "dependencies": ["OtherModule"]
    }
  ],
  "dataFlow": "User → ModuleA → ModuleB → Database",
  "algorithms": ["Key algorithm descriptions"],
  "entryPoints": ["Where execution starts"]
}`;

  const response = await callM3([
    { role: "system", content: systemPrompt },
    { role: "user", content: `Specification:\n${specification}\n\nOriginal request: ${userRequest}` },
  ], 4096);

  let pseudocode: any;
  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    pseudocode = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch {
    pseudocode = null;
  }

  // Gate check: pseudocode must define modules and data flow
  const criteria: GateCriteria[] = [
    { name: "Has modules", met: Array.isArray(pseudocode?.modules) && pseudocode.modules.length > 0, detail: `${pseudocode?.modules?.length || 0} modules defined` },
    { name: "Has data flow", met: !!pseudocode?.dataFlow, detail: pseudocode?.dataFlow ? "Data flow defined" : "Missing data flow" },
    { name: "Modules have dependencies", met: pseudocode?.modules?.some((m: any) => m.dependencies?.length > 0), detail: "Module dependencies mapped" },
    { name: "Has entry points", met: Array.isArray(pseudocode?.entryPoints) && pseudocode.entryPoints.length > 0, detail: "Entry points defined" },
  ];

  const passed = criteria.filter(c => c.met).length >= 2;
  const score = Math.round((criteria.filter(c => c.met).length / criteria.length) * 100);

  return {
    phase: "pseudocode",
    success: passed,
    output: response.content,
    gateCheck: { passed, criteria, score },
    duration: Date.now() - start,
  };
}

// ============================================================
// Phase 3: Architecture
// ============================================================

async function runArchitecture(pseudocode: string, specification: string): Promise<PhaseResult> {
  const start = Date.now();

  const systemPrompt = `You are a software architect. Design the file structure and module organization.

Return JSON:
{
  "files": [
    {
      "path": "src/...",
      "description": "What this file does",
      "exports": ["exported names"],
      "imports": ["import sources"],
      "lines": 100
    }
  ],
  "sharedTypes": ["Type definitions shared across files"],
  "entryPoints": ["Files the framework loads"],
  "toolChain": ["npm packages needed"]
}`;

  const response = await callM3([
    { role: "system", content: systemPrompt },
    { role: "user", content: `Pseudocode:\n${pseudocode}\n\nSpecification:\n${specification}` },
  ], 4096);

  let architecture: any;
  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    architecture = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch {
    architecture = null;
  }

  // Gate check: architecture must define files with resolved dependencies
  const criteria: GateCriteria[] = [
    { name: "Has files", met: Array.isArray(architecture?.files) && architecture.files.length > 0, detail: `${architecture?.files?.length || 0} files planned` },
    { name: "Files have paths", met: architecture?.files?.every((f: any) => f.path), detail: "All files have paths" },
    { name: "Has shared types", met: Array.isArray(architecture?.sharedTypes), detail: `${architecture?.sharedTypes?.length || 0} shared types` },
    { name: "Dependencies resolved", met: architecture?.files?.every((f: any) => Array.isArray(f.imports)), detail: "Import graph defined" },
  ];

  const passed = criteria.filter(c => c.met).length >= 3;
  const score = Math.round((criteria.filter(c => c.met).length / criteria.length) * 100);

  return {
    phase: "architecture",
    success: passed,
    output: response.content,
    gateCheck: { passed, criteria, score },
    duration: Date.now() - start,
  };
}

// ============================================================
// Phase 4: Refinement (Implementation)
// ============================================================

async function runRefinement(architecture: string, pseudocode: string): Promise<PhaseResult> {
  const start = Date.now();

  // This phase uses tool calls to actually write files
  const systemPrompt = `You are a senior developer. Implement the code based on the architecture and pseudocode.

You have these tools:
- write_file: Create files (you MUST use this, don't output code as text)
- edit_file: Edit existing files
- read_file: Read files for context

RULES:
1. Create EVERY file from the architecture plan
2. Use write_file tool for each file
3. Implement complete, working code
4. Include error handling
5. Follow the pseudocode logic`;

  const response = await callM3WithTools(
    systemPrompt,
    [{ role: "user", content: `Architecture:\n${architecture}\n\nPseudocode:\n${pseudocode}` }],
    [
      { type: "function", function: { name: "write_file", description: "Create a file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
      { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
      { type: "function", function: { name: "edit_file", description: "Edit a file", parameters: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } } },
    ],
    16384
  );

  // Gate check: refinement must have produced tool calls
  const hasToolCalls = response.toolCalls.length > 0;
  const hasCode = response.content.length > 100;

  const criteria: GateCriteria[] = [
    { name: "Used write_file", met: hasToolCalls, detail: hasToolCalls ? `${response.toolCalls.length} file operations` : "No file operations" },
    { name: "Produced output", met: hasCode, detail: `${response.content.length} chars output` },
    { name: "Has implementation", met: response.content.includes("function") || response.content.includes("class") || response.content.includes("export"), detail: "Code structures found" },
  ];

  const passed = criteria.filter(c => c.met).length >= 2;
  const score = Math.round((criteria.filter(c => c.met).length / criteria.length) * 100);

  return {
    phase: "refinement",
    success: passed,
    output: response.content,
    gateCheck: { passed, criteria, score },
    duration: Date.now() - start,
  };
}

// ============================================================
// Phase 5: Completion
// ============================================================

async function runCompletion(refinementOutput: string, specification: string): Promise<PhaseResult> {
  const start = Date.now();

  const systemPrompt = `You are a QA engineer. Review the implementation against the specification.

Check:
1. Are all requirements met?
2. Is there error handling?
3. Are there loading states?
4. Is the code production-ready?
5. What's missing?

Return JSON:
{
  "requirementsMet": 8,
  "totalRequirements": 10,
  "issues": [{"severity": "critical|warning|info", "description": "...", "fix": "..."}],
  "score": 85,
  "readyToShip": false,
  "missingFeatures": ["feature1", "feature2"]
}`;

  const response = await callM3([
    { role: "system", content: systemPrompt },
    { role: "user", content: `Implementation:\n${refinementOutput.slice(0, 4000)}\n\nSpecification:\n${specification}` },
  ], 4096);

  let completion: any;
  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    completion = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch {
    completion = null;
  }

  // Gate check: completion must verify requirements
  const score = completion?.score || 0;
  const criteria: GateCriteria[] = [
    { name: "Score >= 70", met: score >= 70, detail: `Score: ${score}/100` },
    { name: "Has issue list", met: Array.isArray(completion?.issues), detail: `${completion?.issues?.length || 0} issues found` },
    { name: "Requirements tracked", met: completion?.requirementsMet !== undefined, detail: `${completion?.requirementsMet || 0}/${completion?.totalRequirements || "?"} met` },
    { name: "Ready to ship", met: completion?.readyToShip === true, detail: completion?.readyToShip ? "Ready" : "Needs fixes" },
  ];

  const passed = score >= 60; // Lower threshold — completion is advisory
  const gateScore = Math.round((criteria.filter(c => c.met).length / criteria.length) * 100);

  return {
    phase: "completion",
    success: passed,
    output: response.content,
    gateCheck: { passed, criteria, score: gateScore },
    duration: Date.now() - start,
  };
}

// ============================================================
// SPARC Orchestrator — Runs all 5 phases with gates
// ============================================================

export async function runSPARC(
  userRequest: string,
  onPhaseComplete?: (phase: PhaseResult) => void
): Promise<SPARCTask> {
  const task: SPARCTask = {
    id: `sparc-${Date.now()}`,
    userRequest,
    phases: [],
    currentPhase: "specification",
    status: "running",
    totalDuration: 0,
  };

  const startTime = Date.now();

  // Phase 1: Specification
  console.log("[SPARC] Phase 1: Specification");
  const specResult = await runSpecification(userRequest);
  task.phases.push(specResult);
  onPhaseComplete?.(specResult);

  if (!specResult.gateCheck.passed) {
    task.status = "failed";
    task.totalDuration = Date.now() - startTime;
    return task;
  }

  // Phase 2: Pseudocode
  console.log("[SPARC] Phase 2: Pseudocode");
  const pseudoResult = await runPseudocode(specResult.output, userRequest);
  task.phases.push(pseudoResult);
  task.currentPhase = "pseudocode";
  onPhaseComplete?.(pseudoResult);

  if (!pseudoResult.gateCheck.passed) {
    task.status = "failed";
    task.totalDuration = Date.now() - startTime;
    return task;
  }

  // Phase 3: Architecture
  console.log("[SPARC] Phase 3: Architecture");
  const archResult = await runArchitecture(pseudoResult.output, specResult.output);
  task.phases.push(archResult);
  task.currentPhase = "architecture";
  onPhaseComplete?.(archResult);

  if (!archResult.gateCheck.passed) {
    task.status = "failed";
    task.totalDuration = Date.now() - startTime;
    return task;
  }

  // Phase 4: Refinement
  console.log("[SPARC] Phase 4: Refinement");
  const refineResult = await runRefinement(archResult.output, pseudoResult.output);
  task.phases.push(refineResult);
  task.currentPhase = "refinement";
  onPhaseComplete?.(refineResult);

  if (!refineResult.gateCheck.passed) {
    task.status = "failed";
    task.totalDuration = Date.now() - startTime;
    return task;
  }

  // Phase 5: Completion
  console.log("[SPARC] Phase 5: Completion");
  const completionResult = await runCompletion(refineResult.output, specResult.output);
  task.phases.push(completionResult);
  task.currentPhase = "completion";
  onPhaseComplete?.(completionResult);

  task.status = completionResult.gateCheck.passed ? "completed" : "failed";
  task.totalDuration = Date.now() - startTime;

  return task;
}

/**
 * Get a summary of a SPARC task execution.
 */
export function getSPARCSummary(task: SPARCTask): string {
  const lines = [
    `## SPARC Execution: ${task.status.toUpperCase()}`,
    `Duration: ${(task.totalDuration / 1000).toFixed(1)}s`,
    "",
    "### Phases",
  ];

  for (const phase of task.phases) {
    const icon = phase.gateCheck.passed ? "PASS" : "FAIL";
    lines.push(`- **${phase.phase}** [${icon}] — ${phase.gateCheck.score}% — ${(phase.duration / 1000).toFixed(1)}s`);
    for (const criteria of phase.gateCheck.criteria) {
      lines.push(`  - ${criteria.met ? "+" : "-"} ${criteria.name}: ${criteria.detail}`);
    }
  }

  return lines.join("\n");
}
