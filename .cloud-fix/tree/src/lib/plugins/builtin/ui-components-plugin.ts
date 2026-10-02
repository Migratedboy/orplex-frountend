/**
 * UI Components Plugin — Detects when component patterns are used
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "ui-components",
  version: "1.0.0",
  description: "Detects UI component patterns and suggests improvements",
  author: "Orplex",
  hooks: ["afterToolCall"],
};

const hooks: PluginHook[] = [{
  name: "afterToolCall",
  handler: async (ctx: HookContext): Promise<HookResult> => {
    if (ctx.tool !== "write_file") return { continue: true };
    const path = (ctx.args?.path as string) || "";
    const content = (ctx.args?.content as string) || "";
    if (!path.endsWith(".tsx")) return { continue: true };
    const issues: string[] = [];
    if (content.includes("className=\"\"") || content.includes("className=''")) issues.push("Empty className found");
    if (content.includes("style={{") && content.split("style={{").length > 5) issues.push("Many inline styles — consider Tailwind classes");
    if (!content.includes("export default") && !content.includes("export function")) issues.push("Component has no export");
    if (issues.length > 0) return { continue: true, message: `UIComponents: ${issues.join("; ")}` };
    return { continue: true };
  },
}];

export async function activateUIComponents(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) { if (!h.has(hook.name)) h.set(hook.name, []); h.get(hook.name).push({ plugin: "ui-components", handler: hook.handler }); }
  }, async () => {});
}
