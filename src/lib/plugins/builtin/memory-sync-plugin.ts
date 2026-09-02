/**
 * Memory Sync Plugin — Persists SONA memory to localStorage
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "memory-sync",
  version: "1.0.0",
  description: "Persists learning memory across sessions via localStorage",
  author: "Orplex",
  hooks: ["onTaskComplete"],
};

const hooks: PluginHook[] = [{
  name: "onTaskComplete",
  handler: async (ctx: HookContext): Promise<HookResult> => {
    try {
      const { getSONAStats } = await import("../../sona");
      const stats = await getSONAStats();
      if (typeof window !== "undefined") {
        localStorage.setItem("orplex:sona-stats", JSON.stringify(stats));
      }
    } catch {}
    return { continue: true };
  },
}];

export async function activateMemorySync(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) { if (!h.has(hook.name)) h.set(hook.name, []); h.get(hook.name).push({ plugin: "memory-sync", handler: hook.handler }); }
  }, async () => {});
}
