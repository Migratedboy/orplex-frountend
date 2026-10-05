// risk-db.ts — the SERVER lane's C6 risk lookup: the same classification
// the browser lane gets from risk-hint.ts, but fed from the Phase 5 tool
// snapshot (ToolAnnotations) and the Prisma autoApproveReadOnly toggle —
// no localStorage exists where the executor runs. Any read failure fails
// closed (no annotations → medium, approval required).

import { classifyRisk, mcpRiskHintFrom, type RiskAssessment } from "../risk-classifier";
import { parseMcpToolName } from "../mcp-client";
import { getToolSnapshot, loadMcpServerPrefsDb } from "./tool-snapshot";

export async function assessMcpToolRiskDb(userId: string, fullName: string): Promise<RiskAssessment> {
  const parsed = parseMcpToolName(fullName);
  if (!parsed) return classifyRisk(fullName, {});
  try {
    const [tool, prefs] = await Promise.all([
      getToolSnapshot(userId, parsed.server).then((rows) => rows.find((t) => t.name === parsed.tool)),
      loadMcpServerPrefsDb(userId, parsed.server),
    ]);
    return classifyRisk(
      fullName,
      {},
      mcpRiskHintFrom(tool?.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean } | null, prefs.autoApproveReadOnly)
    );
  } catch {
    return classifyRisk(fullName, {});
  }
}
