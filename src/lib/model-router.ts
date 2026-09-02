/**
 * model-router.ts — 3-Tier Intelligent Model Routing
 *
 * Routes tasks to the cheapest model that can handle them:
 *   Tier 1 (Simple):  Llama 3.2 8B   — greetings, file reads, simple questions
 *   Tier 2 (Medium):  GPT-OSS-120B  — code generation, tool calling, edits
 *   Tier 3 (Complex): Claude Sonnet  — architecture, multi-file refactors, security
 *
 * Based on Ruflo's 3-tier system that achieves 75% cost reduction.
 */

export type Tier = 1 | 2 | 3;

export interface ModelConfig {
  tier: Tier;
  name: string;
  model: string;
  baseUrl: string;
  apiKeyEnvVar: string;
  maxTokens: number;
  temperature: number;
  costPer1kTokens: number; // relative cost for tracking
}

// ============================================================
// Model Definitions — one per tier
// ============================================================

export const TIER_MODELS: Record<Tier, ModelConfig> = {
  1: {
    tier: 1,
    name: "fast",
    model: "minimax/minimax-m3:free",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    maxTokens: 500000,
    temperature: 0.3,
    costPer1kTokens: 0,
  },
  2: {
    tier: 2,
    name: "standard",
    model: "minimax/minimax-m3:free",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    maxTokens: 500000,
    temperature: 0.7,
    costPer1kTokens: 0,
  },
  3: {
    tier: 3,
    name: "premium",
    model: "minimax/minimax-m3:free",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    maxTokens: 500000,
    temperature: 0.5,
    costPer1kTokens: 0,
  },
};

// ============================================================
// Complexity Classification — decides which tier to use
// ============================================================

interface ComplexitySignals {
  wordCount: number;
  hasCodeKeywords: boolean;
  hasMultiFileKeywords: boolean;
  hasArchitectureKeywords: boolean;
  hasSecurityKeywords: boolean;
  hasToolCalls: boolean;
  messageCount: number;
  hasExistingCode: boolean;
}

function analyzeComplexity(
  userMessage: string,
  messages: { role: string; content: string }[]
): ComplexitySignals {
  const lower = userMessage.toLowerCase();
  return {
    wordCount: userMessage.split(/\s+/).length,
    hasCodeKeywords: /\b(implement|refactor|debug|fix|build|create|write|code|function|component|api|route|schema|migration)\b/i.test(lower),
    hasMultiFileKeywords: /\b(multi|several|all|every|across|entire|full|complete|production|enterprise|system|platform|dashboard)\b/i.test(lower),
    hasArchitectureKeywords: /\b(architecture|design|structure|pattern|scalab|microservice|monolith|event-driven|cqrs|ddd)\b/i.test(lower),
    hasSecurityKeywords: /\b(security|auth|encrypt|vulnerability|csrf|xss|injection|sanitize|audit)\b/i.test(lower),
    hasToolCalls: messages.some(m => m.role === "assistant" && m.content.includes("tool_call")),
    messageCount: messages.length,
    hasExistingCode: messages.some(m => m.role === "user" && (m.content.includes("```") || m.content.includes("import ") || m.content.includes("function "))),
  };
}

export function classifyTier(signals: ComplexitySignals): Tier {
  // Tier 3: Architecture, security, multi-file complex refactors
  if (signals.hasArchitectureKeywords) return 3;
  if (signals.hasSecurityKeywords && signals.hasMultiFileKeywords) return 3;
  if (signals.hasMultiFileKeywords && signals.hasCodeKeywords && signals.wordCount > 50) return 3;
  if (signals.messageCount > 10 && signals.hasCodeKeywords) return 3; // Long conversation about code

  // Tier 2: Code generation, tool calling, moderate complexity
  if (signals.hasCodeKeywords) return 2;
  if (signals.hasToolCalls) return 2;
  if (signals.hasExistingCode) return 2;
  if (signals.wordCount > 30) return 2;

  // Tier 1: Simple greetings, questions, file reads
  return 1;
}

// ============================================================
// Smart Routing API
// ============================================================

export interface RoutingDecision {
  tier: Tier;
  model: ModelConfig;
  reason: string;
  estimatedCost: number;
}

/**
 * Route a request to the optimal model tier.
 *
 * @param userMessage - The current user message
 * @param messages - Full conversation history
 * @param forceTier - Override automatic classification (for testing or user preference)
 * @returns Routing decision with model config and reasoning
 */
export function routeToModel(
  userMessage: string,
  messages: { role: string; content: string }[] = [],
  forceTier?: Tier
): RoutingDecision {
  const signals = analyzeComplexity(userMessage, messages);
  const tier = forceTier || classifyTier(signals);
  const model = TIER_MODELS[tier];

  const reasons: string[] = [];
  if (signals.hasArchitectureKeywords) reasons.push("architecture keywords");
  if (signals.hasSecurityKeywords) reasons.push("security keywords");
  if (signals.hasMultiFileKeywords) reasons.push("multi-file keywords");
  if (signals.hasCodeKeywords) reasons.push("code keywords");
  if (signals.hasToolCalls) reasons.push("tool calls in history");
  if (signals.wordCount > 50) reasons.push("long prompt");
  if (signals.messageCount > 10) reasons.push("long conversation");

  const reason = reasons.length > 0
    ? `Tier ${tier} (${model.name}): ${reasons.join(", ")}`
    : `Tier ${tier} (${model.name}): default routing`;

  // Estimate cost based on token count (rough: 1 token ≈ 4 chars)
  const estimatedTokens = (userMessage.length + messages.reduce((s, m) => s + m.content.length, 0)) / 4;
  const estimatedCost = (estimatedTokens / 1000) * model.costPer1kTokens;

  return { tier, model, reason, estimatedCost };
}

// ============================================================
// Cost Tracking
// ============================================================

interface CostEntry {
  timestamp: number;
  tier: Tier;
  model: string;
  tokens: number;
  cost: number;
  task: string;
}

let costLog: CostEntry[] = [];
const MAX_LOG_ENTRIES = 500;

export function logCost(tier: Tier, tokens: number, task: string): void {
  const model = TIER_MODELS[tier];
  costLog.push({
    timestamp: Date.now(),
    tier,
    model: model.model,
    tokens,
    cost: (tokens / 1000) * model.costPer1kTokens,
    task: task.slice(0, 100),
  });
  if (costLog.length > MAX_LOG_ENTRIES) {
    costLog = costLog.slice(-MAX_LOG_ENTRIES);
  }
}

export function getCostStats(): {
  totalCost: number;
  byTier: Record<Tier, { calls: number; tokens: number; cost: number }>;
  savings: number; // cost if everything used Tier 3
  savingsPercent: number;
} {
  const byTier: Record<Tier, { calls: number; tokens: number; cost: number }> = {
    1: { calls: 0, tokens: 0, cost: 0 },
    2: { calls: 0, tokens: 0, cost: 0 },
    3: { calls: 0, tokens: 0, cost: 0 },
  };

  let totalCost = 0;
  let totalTokens = 0;

  for (const entry of costLog) {
    byTier[entry.tier].calls++;
    byTier[entry.tier].tokens += entry.tokens;
    byTier[entry.tier].cost += entry.cost;
    totalCost += entry.cost;
    totalTokens += entry.tokens;
  }

  // What it would cost if everything used Tier 3
  const savings = (totalTokens / 1000) * TIER_MODELS[3].costPer1kTokens - totalCost;
  const savingsPercent = savings > 0 ? (savings / ((totalTokens / 1000) * TIER_MODELS[3].costPer1kTokens)) * 100 : 0;

  return { totalCost, byTier, savings, savingsPercent };
}
