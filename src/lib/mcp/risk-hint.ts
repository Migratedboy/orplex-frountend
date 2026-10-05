// risk-hint.ts — approval hints for mcp__ tools in the BROWSER lane (C6).
//
// Two sources, both renderer-safe (localStorage only — this module must stay
// importable from client bundles, so no Prisma, no hub):
//   • readOnlyHint / destructiveHint → the server's ToolAnnotations, cached
//     in the localStorage registry by the legacy client's tools/list
//   • auto-approve-read-only toggle  → per-server user pref (mcp.prefs.v1);
//     the Prisma-backed SDK lane reads the same toggle from its own store in
//     tool-builder (Phase 5) — one setting, two lookups per transport lane.
//
// classifyRisk fails closed on every path: no annotation → medium.

import { classifyRisk, mcpRiskHintFrom, type McpRiskHint, type RiskAssessment } from "../risk-classifier";
import { findRemote, parseMcpToolName } from "./registry";

export const MCP_PREFS_KEY = "orplex.mcp.prefs.v1";

export interface McpServerPrefs {
  autoApproveReadOnly?: boolean;
}

function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false;
  }
}

/** All per-server MCP prefs, tolerating garbage/absent storage. */
export function loadMcpPrefs(): Record<string, McpServerPrefs> {
  if (!hasLocalStorage()) return {};
  try {
    const raw = localStorage.getItem(MCP_PREFS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, McpServerPrefs>) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function loadMcpServerPrefs(serverId: string): McpServerPrefs {
  return loadMcpPrefs()[serverId] ?? {};
}

/** Merge-patch one server's prefs (flip the toggle without clobbering others). */
export function saveMcpServerPrefs(serverId: string, patch: McpServerPrefs): void {
  if (!hasLocalStorage()) return;
  try {
    const all = loadMcpPrefs();
    all[serverId] = { ...all[serverId], ...patch };
    localStorage.setItem(MCP_PREFS_KEY, JSON.stringify(all));
  } catch {}
}

/**
 * Look up the hints classifyRisk needs for a full `mcp__<server>__<tool>`
 * name. Synchronous — registry and prefs are localStorage reads.
 */
export function getMcpRiskHint(fullName: string): McpRiskHint {
  const parsed = parseMcpToolName(fullName);
  if (!parsed) return {};
  const server = findRemote(parsed.serverId);
  const tool = server?.tools?.find((t) => t.name === parsed.toolName);
  const prefs = loadMcpServerPrefs(parsed.serverId);
  return mcpRiskHintFrom(tool?.annotations, prefs.autoApproveReadOnly);
}

/** Full risk assessment for one MCP tool call — what the dispatch gate uses. */
export function assessMcpToolRisk(fullName: string): RiskAssessment {
  return classifyRisk(fullName, {}, getMcpRiskHint(fullName));
}
