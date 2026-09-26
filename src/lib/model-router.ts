/**
 * model-router.ts — 3-Tier Model Routing
 *
 * Routes tasks to the configured model for each complexity tier:
 *   Tier 1 (Simple):  greetings, file reads, simple questions
 *   Tier 2 (Medium):  code generation, tool calling, edits
 *   Tier 3 (Complex): architecture, multi-file refactors, security
 *
 * HONESTY NOTE (read before quoting cost numbers):
 * By default ALL THREE tiers point at the same free Groq model, so routing
 * currently only varies maxTokens/temperature — there is no cost saving to
 * claim and `getCostStats().savings` will correctly report 0 while
 * `tiersDiverge` is false. To make routing real, configure per-tier models:
 *
 *   TIER1_MODEL=llama-3.2-90b-text-preview   TIER1_COST_PER_1K=0
 *   TIER2_MODEL=openai/gpt-oss-120b          TIER2_COST_PER_1K=0
 *   TIER3_MODEL=<paid-model-id>              TIER3_COST_PER_1K=0.003
 *
 * (plus optional TIERn_BASE_URL / TIERn_API_KEY_ENV). Once tiers point at
 * different models with real prices, savings reporting becomes meaningful.
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
  /** USD per 1,000 tokens. 0 = free tier. Env-overridable per tier. */
  costPer1kTokens: number;
}

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : fallback;
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const GROQ_BASE_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const DEFAULT_API_KEY_ENV = "GROQ_API_KEY";

function tierConfig(tier: Tier, name: string, maxTokens: number, temperature: number): ModelConfig {
  return {
    tier,
    name,
    model: envStr(`TIER${tier}_MODEL`, DEFAULT_MODEL),
    baseUrl: envStr(`TIER${tier}_BASE_URL`, GROQ_BASE_URL),
    apiKeyEnvVar: envStr(`TIER${tier}_API_KEY_ENV`, DEFAULT_API_KEY_ENV),
    maxTokens,
    temperature,
    costPer1kTokens: envNum(`TIER${tier}_COST_PER_1K`, 0),
  };
}

// ============================================================
// Model Definitions — one per tier (env-configurable)
// ============================================================

export const TIER_MODELS: Record<Tier, ModelConfig> = {
  1: tierConfig(1, "fast", 8192, 0.3),
  2: tierConfig(2, "standard", 32768, 0.7),
  3: tierConfig(3, "premium", 65536, 0.5),
};

/** True when the three tiers actually route to different models. When false, cost "savings" are structurally zero and must not be advertised. */
export function tiersDiverge(): boolean {
  const m1 = TIER_MODELS[1].model;
  const m2 = TIER_MODELS[2].model;
  const m3 = TIER_MODELS[3].model;
  return m1 !== m2 || m2 !== m3;
}

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
  /** False when this tier maps to the same model as the others (the default) — i.e. routing changed nothing but token limits. */
  routedToDistinctModel: boolean;
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

  return {
    tier,
    model,
    reason,
    estimatedCost,
    routedToDistinctModel: model.model !== TIER_MODELS[2].model || model.model !== TIER_MODELS[1].model,
  };
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
  /** Cost if every request had used the Tier-3 model. Meaningless (0) while all tiers share one model. */
  savings: number;
  savingsPercent: number;
  /** False while all three tiers route to the same model — suppress "savings" messaging in that case. */
  tiersDiverge: boolean;
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

  // What it would cost if everything used Tier 3 — only a real saving when
  // Tier 3 is actually a different (pricier) model than what ran.
  const allTier3Cost = (totalTokens / 1000) * TIER_MODELS[3].costPer1kTokens;
  const savings = tiersDiverge() ? allTier3Cost - totalCost : 0;
  const savingsPercent = savings > 0 ? (savings / allTier3Cost) * 100 : 0;

  return { totalCost, byTier, savings, savingsPercent, tiersDiverge: tiersDiverge() };
}
