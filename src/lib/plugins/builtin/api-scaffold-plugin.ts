/**
 * API Scaffold Plugin — Detects API route patterns
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "api-scaffold",
  version: "1.0.0",
  description: "Detects API route patterns and suggests CRUD completeness",
  author: "Orplex",
  hooks: ["afterToolCall"],
};

const hooks: PluginHook[] = [{
  name: "afterToolCall",
  handler: async (ctx: HookContext): Promise<HookResult> => {
    if (ctx.tool !== "write_file") return { continue: true };
    const path = (ctx.args?.path as string) || "";
    if (!path.includes("/api/")) return { continue: true };
    const content = (ctx.args?.content as string) || "";
    const methods = ["GET", "POST", "PUT", "DELETE", "PATCH"];
    const missing = methods.filter(m => !content.includes(m));
    if (missing.length > 0 && missing.length < 5) {
      return { continue: true, message: "APIScaffold: Missing HTTP methods: " + missing.join(", ") };
    }
    return { continue: true };
  },
}];

export async function activateAPIScaffold(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) { if (!h.has(hook.name)) h.set(hook.name, []); h.get(hook.name).push({ plugin: "api-scaffold", handler: hook.handler }); }
  }, async () => {});
}
