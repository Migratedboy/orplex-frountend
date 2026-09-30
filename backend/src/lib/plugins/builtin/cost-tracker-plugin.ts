/**
 * Cost Tracker Plugin — Tracks API costs per tier
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "cost-tracker",
  version: "1.0.0",
  description: "Tracks API costs, shows daily/weekly/monthly spend by tier",
  author: "Orplex",
  hooks: ["onTaskComplete", "onTaskFail"],
};

interface CostEntry { timestamp: number; tier: number; tokens: number; cost: number; task: string; }
let costLog: CostEntry[] = [];

const COST_PER_1K = { 1: 0.01, 2: 0.05, 3: 0.15 };

const hooks: PluginHook[] = [
  {
    name: "onTaskComplete",
    handler: async (ctx: HookContext): Promise<HookResult> => {
      const tier = (ctx as any).tier || 2;
      const tokens = ((ctx.result || "").length / 4) || 500;
      const cost = (tokens / 1000) * (COST_PER_1K[tier as keyof typeof COST_PER_1K] || 0.05);
      costLog.push({ timestamp: Date.now(), tier, tokens, cost, task: (ctx.task || "").slice(0, 60) });
      if (costLog.length > 500) costLog = costLog.slice(-500);
      return { continue: true, message: `Cost: $${cost.toFixed(4)} (Tier ${tier})` };
    },
  },
  { name: "onTaskFail", handler: async () => ({ continue: true }) },
];

export function getCostStats() {
  const now = Date.now();
  const day = costLog.filter(e => now - e.timestamp < 86400000);
  const week = costLog.filter(e => now - e.timestamp < 604800000);
  return {
    today: { calls: day.length, cost: day.reduce((s, e) => s + e.cost, 0) },
    thisWeek: { calls: week.length, cost: week.reduce((s, e) => s + e.cost, 0) },
    allTime: { calls: costLog.length, cost: costLog.reduce((s, e) => s + e.cost, 0) },
  };
}

export async function activateCostTracker(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) {
      if (!h.has(hook.name)) h.set(hook.name, []);
      h.get(hook.name).push({ plugin: "cost-tracker", handler: hook.handler });
    }
  }, async () => {});
}
