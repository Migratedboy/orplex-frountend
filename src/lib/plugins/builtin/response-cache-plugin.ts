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
/**
 * Hard cap on entries. The TTL only gated HITS - stale entries were never swept
 * and there was no size limit, so every distinct tool-argument set inserted a
 * full response string (read_file results alone run to 200KB) that lived for the
 * life of the process. Sibling caches here are bounded: semantic-cache caps at
 * 1000, notify sweeps at 500. This one had neither.
 */
const MAX_ENTRIES = 200;

/** Drop expired entries, and evict the oldest if still over the cap. */
function prune(): void {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.timestamp >= TTL) cache.delete(k);
  }
  while (cache.size > MAX_ENTRIES) {
    // Map preserves insertion order, so the first key is the oldest write.
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

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
        prune();
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
