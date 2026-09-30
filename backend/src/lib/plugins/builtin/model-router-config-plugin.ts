/**
 * Model Router Config Plugin — Logs which tier is being used
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "model-router-config",
  version: "1.0.0",
  description: "Logs model tier selection for each tool call",
  author: "Orplex",
  hooks: ["beforeToolCall"],
};

let callCount = 0;

const hooks: PluginHook[] = [{
  name: "beforeToolCall",
  handler: async (ctx: HookContext): Promise<HookResult> => {
    callCount++;
    return { continue: true, message: `ModelRouter: Call #${callCount} for ${ctx.tool}` };
  },
}];

export function getModelRouterStats() { return { totalCalls: callCount }; }

export async function activateModelRouterConfig(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) { if (!h.has(hook.name)) h.set(hook.name, []); h.get(hook.name).push({ plugin: "model-router-config", handler: hook.handler }); }
  }, async () => {});
}
