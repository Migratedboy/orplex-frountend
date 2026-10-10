// contract/risk.ts — Shared risk-classification contract (Step A).
//
// Single import point for tool risk tiers used by BOTH execution modes.
// Re-exports the canonical implementation in ../../risk-classifier.
export {
  classifyRisk,
  mcpRiskHintFrom,
  riskRank,
  type RiskLevel,
  type RiskAssessment,
  type McpRiskHint,
} from "../../risk-classifier";
