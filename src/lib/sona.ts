/**
 * sona.ts — Self-Organizing Neural Architecture
 *
 * Learns from past task trajectories to improve future performance.
 * Based on Ruflo's SONA system that tracks what works and what doesn't.
 *
 * Key concepts:
 * - Trajectory: A sequence of steps taken to solve a task
 * - Pattern: A reusable approach that worked for similar tasks
 * - Confidence: How likely a pattern will succeed for a new task
 */

import crypto from "crypto";
import { prisma } from "./prisma";

// ============================================================
// Types
// ============================================================

export interface TrajectoryStep {
  tool: string;
  args: Record<string, unknown>;
  success: boolean;
  output: string;
  duration: number;
}

export interface Trajectory {
  id: string;
  task: string;
  taskEmbedding: number[];
  steps: TrajectoryStep[];
  outcome: "success" | "partial" | "failure";
  totalDuration: number;
  totalTokens: number;
  filesChanged: string[];
  toolsUsed: string[];
  timestamp: number;
  tags: string[];
}

export interface Pattern {
  id: string;
  name: string;
  description: string;
  embedding: number[];
  steps: string[]; // tool sequence, e.g. ["read_file", "edit_file", "run_command"]
  successRate: number;
  useCount: number;
  avgDuration: number;
  tags: string[];
}

export interface LearningResult {
  trajectory: Trajectory;
  patternsExtracted: Pattern[];
  recommendations: string[];
  confidenceScore: number;
}

// ============================================================
// Embedding (simple hash-based, no external API needed)
// ============================================================

const EMBEDDING_DIMS = 128;

function embedText(text: string): number[] {
  const lower = text.toLowerCase();
  const words = lower.split(/\\s+/).filter(w => w.length > 2);
  const vec = new Array(EMBEDDING_DIMS).fill(0);
  for (const word of words) {
    const hash = simpleHash(word);
    vec[hash % EMBEDDING_DIMS] += 1;
    for (let i = 0; i < word.length - 2; i++) {
      const trigram = word.slice(i, i + 3);
      vec[simpleHash(trigram) % EMBEDDING_DIMS] += 0.5;
    }
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ============================================================
// SONA Engine
// ============================================================

const MAX_TRAJECTORIES = 2000;
const MAX_PATTERNS = 500;

let trajectoryStore: Trajectory[] = [];
let patternStore: Pattern[] = [];
let hydrated = false;

async function hydrateIfNeeded(): Promise<void> {
  if (hydrated) return;
  try {
    const [trajectories, patterns] = await Promise.all([
      prisma.sonaTrajectory.findMany({ orderBy: { createdAt: "desc" }, take: MAX_TRAJECTORIES }),
      prisma.sonaPattern.findMany({ orderBy: { updatedAt: "desc" }, take: MAX_PATTERNS }),
    ]);
    trajectoryStore = trajectories.map((t) => ({
      id: t.id,
      task: t.task,
      taskEmbedding: t.embedding as unknown as number[],
      steps: t.steps as unknown as TrajectoryStep[],
      outcome: t.outcome as Trajectory["outcome"],
      totalDuration: t.totalDuration,
      totalTokens: t.totalTokens,
      filesChanged: t.filesChanged,
      toolsUsed: t.toolsUsed,
      timestamp: t.createdAt.getTime(),
      tags: t.tags,
    }));
    patternStore = patterns.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      embedding: p.embedding as unknown as number[],
      steps: p.steps,
      successRate: p.successRate,
      useCount: p.useCount,
      avgDuration: p.avgDuration,
      tags: p.tags,
    }));
    hydrated = true;
  } catch {
    hydrated = true;
  }
}

function persistTrajectory(t: Trajectory): void {
  prisma.sonaTrajectory.create({
    data: {
      id: t.id,
      task: t.task,
      embedding: t.taskEmbedding as any,
      outcome: t.outcome,
      totalDuration: t.totalDuration,
      totalTokens: t.totalTokens,
      filesChanged: t.filesChanged,
      toolsUsed: t.toolsUsed,
      tags: t.tags,
      steps: t.steps as any,
    },
  }).catch(() => {});
}

function persistPattern(p: Pattern): void {
  prisma.sonaPattern.upsert({
    where: { id: p.id },
    update: {
      successRate: p.successRate,
      useCount: p.useCount,
      avgDuration: p.avgDuration,
    },
    create: {
      id: p.id,
      name: p.name,
      description: p.description,
      embedding: p.embedding as any,
      steps: p.steps,
      successRate: p.successRate,
      useCount: p.useCount,
      avgDuration: p.avgDuration,
      tags: p.tags,
    },
  }).catch(() => {});
}

/**
 * Record a completed trajectory — the core learning event.
 */
export function recordTrajectory(
  task: string,
  steps: TrajectoryStep[],
  outcome: Trajectory["outcome"],
  totalDuration: number,
  totalTokens: number,
  filesChanged: string[] = []
): Trajectory {
  const toolsUsed = [...new Set(steps.map(s => s.tool))];
  const tags = extractTags(task);

  const trajectory: Trajectory = {
    id: crypto.randomUUID(),
    task,
    taskEmbedding: embedText(task),
    steps,
    outcome,
    totalDuration,
    totalTokens,
    filesChanged,
    toolsUsed,
    timestamp: Date.now(),
    tags,
  };

  trajectoryStore.push(trajectory);
  persistTrajectory(trajectory);

  // Extract patterns from successful trajectories
  if (outcome === "success" && steps.length >= 2) {
    const pattern = extractPattern(trajectory);
    if (pattern) upsertPattern(pattern);
  }

  // Evict old trajectories
  if (trajectoryStore.length > MAX_TRAJECTORIES) {
    trajectoryStore.sort((a, b) => b.timestamp - a.timestamp);
    trajectoryStore = trajectoryStore.slice(0, MAX_TRAJECTORIES);
  }

  return trajectory;
}

/**
 * Learn from past successes — find similar tasks and extract their patterns.
 */
export async function learnFromSuccesses(
  task: string,
  maxResults: number = 5
): Promise<{
  similarTasks: Trajectory[];
  bestPatterns: Pattern[];
  recommendations: string[];
}> {
  const taskEmbedding = embedText(task);
  const taskTags = extractTags(task);

  // Find similar past trajectories
  const similar = trajectoryStore
    .filter(t => t.outcome === "success")
    .map(t => ({
      trajectory: t,
      similarity: cosineSimilarity(taskEmbedding, t.taskEmbedding),
    }))
    .filter(t => t.similarity > 0.3)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, maxResults)
    .map(t => t.trajectory);

  // Find patterns that match this task's tags
  const matchingPatterns = patternStore
    .filter(p => p.tags.some(t => taskTags.includes(t)) || p.successRate > 0.8)
    .sort((a, b) => b.successRate - a.successRate)
    .slice(0, 3);

  // Generate recommendations
  const recommendations: string[] = [];

  if (similar.length > 0) {
    const avgTools = similar.flatMap(t => t.toolsUsed);
    const toolFreq = new Map<string, number>();
    avgTools.forEach(t => toolFreq.set(t, (toolFreq.get(t) || 0) + 1));
    const topTools = [...toolFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    recommendations.push(`Based on ${similar.length} similar past tasks, use tools: ${topTools.map(([t]) => t).join(", ")}`);

    const avgDuration = similar.reduce((s, t) => s + t.totalDuration, 0) / similar.length;
    recommendations.push(`Similar tasks took ~${(avgDuration / 1000).toFixed(1)}s on average`);
  }

  if (matchingPatterns.length > 0) {
    recommendations.push(`Found ${matchingPatterns.length} proven patterns for this type of task`);
  }

  return { similarTasks: similar, bestPatterns: matchingPatterns, recommendations };
}

/**
 * Pattern matching — find the best approach for a new task.
 */
export async function patternMatch(task: string): Promise<{
  bestPattern: Pattern | null;
  confidence: number;
  suggestedSteps: string[];
}> {
  const taskEmbedding = embedText(task);
  const taskTags = extractTags(task);

  let bestPattern: Pattern | null = null;
  let bestScore = 0;

  for (const pattern of patternStore) {
    // Score = similarity * success rate * usage count (popularity)
    const sim = cosineSimilarity(taskEmbedding, pattern.embedding);
    const tagMatch = pattern.tags.filter(t => taskTags.includes(t)).length / Math.max(taskTags.length, 1);
    const score = sim * 0.5 + tagMatch * 0.3 + (pattern.successRate * 0.2);

    if (score > bestScore && score > 0.3) {
      bestScore = score;
      bestPattern = pattern;
    }
  }

  return {
    bestPattern,
    confidence: bestScore,
    suggestedSteps: bestPattern ? bestPattern.steps : [],
  };
}

/**
 * Get a confidence score for how well the system can handle a task.
 */
export async function getConfidenceScore(task: string): Promise<{
  score: number; // 0-1
  reasoning: string;
  hasPattern: boolean;
  hasSimilarTask: boolean;
}> {
  const { bestPattern, confidence: patternConfidence } = await patternMatch(task);
  const { similarTasks } = await learnFromSuccesses(task, 1);

  const hasPattern = bestPattern !== null;
  const hasSimilarTask = similarTasks.length > 0;
  const score = Math.min(1, patternConfidence * 0.5 + (hasSimilarTask ? 0.3 : 0) + (hasPattern ? 0.2 : 0));

  const reasoning = score > 0.7
    ? "High confidence — similar tasks succeeded before"
    : score > 0.4
      ? "Medium confidence — some similar patterns exist"
      : "Low confidence — this is a novel task";

  return { score, reasoning, hasPattern, hasSimilarTask };
}

// ============================================================
// Helpers
// ============================================================

function extractPattern(trajectory: Trajectory): Pattern | null {
  if (trajectory.steps.length < 2) return null;

  const stepSequence = trajectory.steps.map(s => s.tool);
  const stepKey = stepSequence.join(" → ");

  // Find existing pattern or create new one
  const existing = patternStore.find(p =>
    p.steps.join(" → ") === stepKey &&
    p.tags.some(t => trajectory.tags.includes(t))
  );

  if (existing) {
    // Update existing pattern
    existing.useCount++;
    existing.successRate = (existing.successRate * (existing.useCount - 1) + 1) / existing.useCount;
    existing.avgDuration = (existing.avgDuration * (existing.useCount - 1) + trajectory.totalDuration) / existing.useCount;
    return existing;
  }

  // Create new pattern
  return {
    id: crypto.randomUUID(),
    name: `${stepSequence[0]} → ${stepSequence[stepSequence.length - 1]}`,
    description: `Pattern for: ${trajectory.task.slice(0, 100)}`,
    embedding: trajectory.taskEmbedding,
    steps: stepSequence,
    successRate: 1.0,
    useCount: 1,
    avgDuration: trajectory.totalDuration,
    tags: trajectory.tags,
  };
}

function upsertPattern(pattern: Pattern): void {
  const existing = patternStore.find(p => p.id === pattern.id);
  if (existing) {
    Object.assign(existing, pattern);
  } else {
    patternStore.push(pattern);
  }
  persistPattern(pattern);

  // Evict low-success patterns
  if (patternStore.length > MAX_PATTERNS) {
    patternStore.sort((a, b) => b.successRate * b.useCount - a.successRate * a.useCount);
    patternStore = patternStore.slice(0, MAX_PATTERNS);
  }
}

function extractTags(text: string): string[] {
  const tags: string[] = [];
  const lower = text.toLowerCase();
  if (lower.includes("auth") || lower.includes("login") || lower.includes("session")) tags.push("auth");
  if (lower.includes("api") || lower.includes("route") || lower.includes("endpoint")) tags.push("api");
  if (lower.includes("component") || lower.includes("ui") || lower.includes("page")) tags.push("ui");
  if (lower.includes("database") || lower.includes("prisma") || lower.includes("sql")) tags.push("database");
  if (lower.includes("error") || lower.includes("bug") || lower.includes("fix")) tags.push("bugfix");
  if (lower.includes("test") || lower.includes("spec")) tags.push("testing");
  if (lower.includes("security") || lower.includes("auth")) tags.push("security");
  if (lower.includes("performance") || lower.includes("optimize")) tags.push("performance");
  if (lower.includes("3d") || lower.includes("three.js") || lower.includes("canvas")) tags.push("3d");
  if (lower.includes("css") || lower.includes("style") || lower.includes("tailwind")) tags.push("styling");
  return [...new Set(tags)];
}

// ============================================================
// Stats & Persistence
// ============================================================

export async function getSONAStats(): Promise<{
  trajectories: number;
  patterns: number;
  avgSuccessRate: number;
  topPatterns: Array<{ name: string; successRate: number; useCount: number }>;
  recentTrajectories: Array<{ task: string; outcome: string; duration: number }>;
}> {
  const avgSuccessRate = patternStore.length > 0
    ? patternStore.reduce((s, p) => s + p.successRate, 0) / patternStore.length
    : 0;

  return {
    trajectories: trajectoryStore.length,
    patterns: patternStore.length,
    avgSuccessRate,
    topPatterns: patternStore
      .sort((a, b) => b.successRate * b.useCount - a.successRate * a.useCount)
      .slice(0, 5)
      .map(p => ({ name: p.name, successRate: p.successRate, useCount: p.useCount })),
    recentTrajectories: trajectoryStore
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 5)
      .map(t => ({ task: t.task.slice(0, 60), outcome: t.outcome, duration: t.totalDuration })),
  };
}
