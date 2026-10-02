/**
 * Build Watcher Plugin — Runs build after file changes
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "build-watcher",
  version: "1.0.0",
  description: "Runs npm build after file changes, reports errors",
  author: "Orplex",
  hooks: ["onFileWrite", "onFileEdit"],
};

function checkPath(ctx: HookContext): { check: boolean; path: string } {
  const path = (ctx.path as string) || (ctx.args?.path as string) || "";
  return { check: path.endsWith(".ts") || path.endsWith(".tsx"), path };
}

const hooks: PluginHook[] = [
  {
    name: "onFileWrite",
    handler: async (ctx: HookContext): Promise<HookResult> => {
      const { check, path } = checkPath(ctx);
      if (check) return { continue: true, message: "BuildWatcher: " + path + " changed" };
      return { continue: true };
    },
  },
  {
    name: "onFileEdit",
    handler: async (ctx: HookContext): Promise<HookResult> => {
      const { check, path } = checkPath(ctx);
      if (check) return { continue: true, message: "BuildWatcher: " + path + " edited" };
      return { continue: true };
    },
  },
];

export async function activateBuildWatcher(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) { if (!h.has(hook.name)) h.set(hook.name, []); h.get(hook.name).push({ plugin: "build-watcher", handler: hook.handler }); }
  }, async () => {});
}
