/**
 * Task Queue Plugin — Tracks concurrent tool calls
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "task-queue",
  version: "1.0.0",
  description: "Tracks concurrent tool calls and detects bottlenecks",
  author: "Orplex",
  hooks: ["beforeToolCall", "afterToolCall"],
};

let activeCalls = 0;
let maxConcurrent = 0;
let totalCalls = 0;

const hooks: PluginHook[] = [
  {
    name: "beforeToolCall",
    handler: async (ctx: HookContext): Promise<HookResult> => {
      activeCalls++;
      totalCalls++;
      if (activeCalls > maxConcurrent) maxConcurrent = activeCalls;
      return { continue: true };
    },
  },
  {
    name: "afterToolCall",
    handler: async (ctx: HookContext): Promise<HookResult> => {
      activeCalls = Math.max(0, activeCalls - 1);
      return { continue: true };
    },
  },
];

export function getTaskQueueStats() { return { activeCalls, maxConcurrent, totalCalls }; }

export async function activateTaskQueue(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) { if (!h.has(hook.name)) h.set(hook.name, []); h.get(hook.name).push({ plugin: "task-queue", handler: hook.handler }); }
  }, async () => {});
}
