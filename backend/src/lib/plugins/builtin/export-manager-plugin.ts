/**
 * Export Manager Plugin — Tracks files for export
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "export-manager",
  version: "1.0.0",
  description: "Tracks files created for enhanced .zip export",
  author: "Orplex",
  hooks: ["onFileWrite"],
};

const trackedFiles: string[] = [];

const hooks: PluginHook[] = [{
  name: "onFileWrite",
  handler: async (ctx: HookContext): Promise<HookResult> => {
    const path = (ctx.path as string) || "";
    if (path && !trackedFiles.includes(path)) trackedFiles.push(path);
    return { continue: true };
  },
}];

export function getTrackedFiles() { return [...trackedFiles]; }
export function clearTrackedFiles() { trackedFiles.length = 0; }

export async function activateExportManager(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) { if (!h.has(hook.name)) h.set(hook.name, []); h.get(hook.name).push({ plugin: "export-manager", handler: hook.handler }); }
  }, async () => {});
}
