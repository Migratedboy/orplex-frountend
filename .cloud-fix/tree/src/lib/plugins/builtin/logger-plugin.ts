/**
 * Logger Plugin — Built-in plugin that logs all tool calls
 *
 * Demonstrates the plugin system and provides useful debugging.
 * This plugin:
 * - Logs every tool call with args and duration
 * - Tracks tool usage counts
 * - Records error rates
 */

import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "logger",
  version: "1.0.0",
  description: "Logs all tool calls and tracks usage statistics",
  author: "Orplex",
  hooks: ["beforeToolCall", "afterToolCall", "onTaskComplete", "onTaskFail"],
};

// Usage tracking
const toolStats = new Map<string, { calls: number; errors: number; totalDuration: number }>();

function trackCall(tool: string, duration: number, error: boolean) {
  const stats = toolStats.get(tool) || { calls: 0, errors: 0, totalDuration: 0 };
  stats.calls++;
  if (error) stats.errors++;
  stats.totalDuration += duration;
  toolStats.set(tool, stats);
}

let currentToolStart = 0;

export function getLoggerStats(): Record<string, { calls: number; errors: number; avgDuration: number }> {
  const result: Record<string, { calls: number; errors: number; avgDuration: number }> = {};
  for (const [tool, stats] of toolStats) {
    result[tool] = {
      calls: stats.calls,
      errors: stats.errors,
      avgDuration: stats.calls > 0 ? Math.round(stats.totalDuration / stats.calls) : 0,
    };
  }
  return result;
}

// Hook implementations
const hooks: PluginHook[] = [
  {
    name: "beforeToolCall",
    handler: async (ctx: HookContext): Promise<HookResult> => {
      currentToolStart = Date.now();
      console.log(`[LOGGER] Before: ${ctx.tool}(${JSON.stringify(ctx.args).slice(0, 100)})`);
      return { continue: true, message: `Logging ${ctx.tool}` };
    },
  },
  {
    name: "afterToolCall",
    handler: async (ctx: HookContext): Promise<HookResult> => {
      const duration = Date.now() - currentToolStart;
      const error = ctx.result?.startsWith("error") || ctx.result?.startsWith("Error") || false;
      trackCall(ctx.tool || "unknown", duration, error);
      console.log(`[LOGGER] After: ${ctx.tool} — ${duration}ms ${error ? "(ERROR)" : "(OK)"}`);
      return { continue: true };
    },
  },
  {
    name: "onTaskComplete",
    handler: async (ctx: HookContext): Promise<HookResult> => {
      console.log(`[LOGGER] Task complete: ${(ctx.task || "").slice(0, 60)}`);
      return { continue: true, message: "Task logged" };
    },
  },
  {
    name: "onTaskFail",
    handler: async (ctx: HookContext): Promise<HookResult> => {
      console.log(`[LOGGER] Task failed: ${(ctx.task || "").slice(0, 60)} — ${ctx.error}`);
      return { continue: true, message: "Failure logged" };
    },
  },
];

// Activation
export async function activateLogger(): Promise<void> {
  await pluginRegistry.registerPlugin(
    manifest,
    async () => {
      // Register hooks
      for (const hook of hooks) {
        const hookHandlers = (pluginRegistry as any).hooks;
        if (!hookHandlers.has(hook.name)) hookHandlers.set(hook.name, []);
        hookHandlers.get(hook.name).push({ plugin: "logger", handler: hook.handler });
      }
    },
    async () => {
      // Cleanup
    }
  );
}
