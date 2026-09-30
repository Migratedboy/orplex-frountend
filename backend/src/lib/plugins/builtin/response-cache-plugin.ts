/**
 * Response Cache Plugin — Caches identical prompts
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "response-cache",
  version: "1.0.0",
  description: "Caches identical prompts, returns cached response instantly",
  author: "Orplex",
  hooks: ["beforeToolCall", "afterToolCall"],
};

const cache = new Map<string, { response: string; timestamp: number }>();
const TTL = 3600000; // 1 hour

const hooks: PluginHook[] = [
  {
    name: "beforeToolCall",
    handler: async (ctx: HookContext): Promise<HookResult> => {
      const key = JSON.stringify(ctx.args);
      const cached = cache.get(key);
      if (cached && Date.now() - cached.timestamp < TTL) {
        return { continue: false, message: "Cache hit — returning cached response" };
      }
      return { continue: true };
    },
  },
  {
    name: "afterToolCall",
    handler: async (ctx: HookContext): Promise<HookResult> => {
      if (ctx.result && ctx.result.length > 0) {
        cache.set(JSON.stringify(ctx.args), { response: ctx.result, timestamp: Date.now() });
      }
      return { continue: true };
    },
  },
];

export function getCacheSize() { return cache.size; }
export async function activateResponseCache(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) { if (!h.has(hook.name)) h.set(hook.name, []); h.get(hook.name).push({ plugin: "response-cache", handler: hook.handler }); }
  }, async () => {});
}
