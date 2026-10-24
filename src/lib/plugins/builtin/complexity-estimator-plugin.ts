/**
 * Complexity Estimator Plugin — Pre-computes task complexity
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";
import { estimateComplexity } from "../../effort";

const manifest: PluginManifest = {
  name: "complexity-estimator",
  version: "1.0.0",
  description: "Pre-computes task complexity, routes to optimal model tier",
  author: "Orplex",
  hooks: ["onTaskStart"],
};

const hooks: PluginHook[] = [{
  name: "onTaskStart",
  handler: async (ctx: HookContext): Promise<HookResult> => {
    // Score the incoming task once and expose the estimate on the hook
    // context — anything downstream (model tier routing, budget logging)
    // reads ctx.estimate instead of rescoring the prompt itself.
    if (typeof ctx.task === "string" && ctx.task.trim()) {
      ctx.estimate = estimateComplexity({ prompt: ctx.task });
    }
    return { continue: true };
  },
}];

export async function activateComplexityEstimator(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) { if (!h.has(hook.name)) h.set(hook.name, []); h.get(hook.name).push({ plugin: "complexity-estimator", handler: hook.handler }); }
  }, async () => {});
}
