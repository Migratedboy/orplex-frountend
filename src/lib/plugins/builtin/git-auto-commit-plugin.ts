/**
 * Git Auto Commit Plugin — Detects when git commit would be useful
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "git-auto-commit",
  version: "1.0.0",
  description: "Suggests git commits after significant file changes",
  author: "Orplex",
  hooks: ["onTaskComplete"],
};

let filesChanged = 0;

const hooks: PluginHook[] = [
  {
    name: "onTaskStart",
    handler: async (): Promise<HookResult> => { filesChanged = 0; return { continue: true }; },
  },
  {
    name: "onTaskComplete",
    handler: async (ctx: HookContext): Promise<HookResult> => {
      if (filesChanged > 0) {
        return { continue: true, message: `GitAutoCommit: ${filesChanged} files changed — consider committing` };
      }
      return { continue: true };
    },
  },
];

export async function activateGitAutoCommit(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) { if (!h.has(hook.name)) h.set(hook.name, []); h.get(hook.name).push({ plugin: "git-auto-commit", handler: hook.handler }); }
  }, async () => {});
}
