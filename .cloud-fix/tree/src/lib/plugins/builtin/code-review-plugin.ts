/**
 * Code Review Plugin — Auto-reviews every file change
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "code-review",
  version: "1.0.0",
  description: "Reviews code quality on every file write — catches issues early",
  author: "Orplex",
  hooks: ["afterToolCall"],
};

const hooks: PluginHook[] = [{
  name: "afterToolCall",
  handler: async (ctx: HookContext): Promise<HookResult> => {
    if (ctx.tool !== "write_file") return { continue: true };
    const path = (ctx.args?.path as string) || "";
    if (!path.match(/\.(ts|tsx|js|jsx)$/)) return { continue: true };
    const content = (ctx.args?.content as string) || "";
    const findings: string[] = [];
    if (content.length > 5000) findings.push("Large file — consider splitting into modules");
    if ((content.match(/import/g) || []).length > 20) findings.push("Many imports — check for circular dependencies");
    if (!content.includes("error") && !content.includes("catch") && content.includes("async")) findings.push("Async code without error handling");
    if (content.includes("TODO") || content.includes("FIXME")) findings.push("Contains TODO/FIXME — resolve before shipping");
    if (findings.length > 0) return { continue: true, message: `Review: ${findings.join("; ")}` };
    return { continue: true };
  },
}];

export async function activateCodeReview(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) { if (!h.has(hook.name)) h.set(hook.name, []); h.get(hook.name).push({ plugin: "code-review", handler: hook.handler }); }
  }, async () => {});
}
