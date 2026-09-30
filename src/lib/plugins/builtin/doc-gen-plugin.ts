/**
 * Doc Gen Plugin — Auto-generates JSDoc for exported functions
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "doc-gen",
  version: "1.0.0",
  description: "Auto-generates JSDoc documentation for exported functions",
  author: "Orplex",
  hooks: ["afterToolCall"],
};

const hooks: PluginHook[] = [{
  name: "afterToolCall",
  handler: async (ctx: HookContext): Promise<HookResult> => {
    if (ctx.tool !== "write_file") return { continue: true };
    const content = (ctx.args?.content as string) || "";
    const exports = content.match(/export\s+(?:async\s+)?function\s+(\w+)/g);
    if (exports && exports.length > 0) {
      return { continue: true, message: `DocGen: ${exports.length} exports found — add JSDoc comments` };
    }
    return { continue: true };
  },
}];

export async function activateDocGen(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) { if (!h.has(hook.name)) h.set(hook.name, []); h.get(hook.name).push({ plugin: "doc-gen", handler: hook.handler }); }
  }, async () => {});
}
