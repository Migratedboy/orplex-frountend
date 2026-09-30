/**
 * Docker Scaffold Plugin — Detects when Dockerfile would be useful
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "docker-scaffold",
  version: "1.0.0",
  description: "Suggests Dockerfile when project has package.json or requirements.txt",
  author: "Orplex",
  hooks: ["onTaskComplete"],
};

const hooks: PluginHook[] = [{
  name: "onTaskComplete",
  handler: async (ctx: HookContext): Promise<HookResult> => {
    const result = ctx.result || "";
    if ((result.includes("package.json") || result.includes("requirements.txt")) && !result.includes("Dockerfile")) {
      return { continue: true, message: "DockerScaffold: Project has entry file but no Dockerfile — consider adding one" };
    }
    return { continue: true };
  },
}];

export async function activateDockerScaffold(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) { if (!h.has(hook.name)) h.set(hook.name, []); h.get(hook.name).push({ plugin: "docker-scaffold", handler: hook.handler }); }
  }, async () => {});
}
