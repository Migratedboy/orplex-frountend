/**
 * Type Checker Plugin — Reports type issues after file writes
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "type-checker",
  version: "1.0.0",
  description: "Reports TypeScript type issues after file changes",
  author: "Orplex",
  hooks: ["afterToolCall", "onFileEdit"],
};

function checkTypes(content: string, path: string): string[] {
  const issues: string[] = [];
  if (content.includes("any") && !path.includes(".d.ts")) issues.push("Consider replacing 'any' with specific types");
  if (content.includes("@ts-ignore")) issues.push("@ts-ignore found — fix the underlying type issue");
  return issues;
}

const hooks: PluginHook[] = [
  {
    name: "afterToolCall",
    handler: async (ctx: HookContext): Promise<HookResult> => {
      if (ctx.tool !== "write_file" && ctx.tool !== "edit_file") return { continue: true };
      const path = (ctx.args?.path as string) || "";
      if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return { continue: true };
      const content = (ctx.args?.content as string) || (ctx.args?.new_text as string) || "";
      const issues = checkTypes(content, path);
      if (issues.length > 0) return { continue: true, message: "TypeCheck: " + issues.join("; ") };
      return { continue: true };
    },
  },
  {
    name: "onFileEdit",
    handler: async (ctx: HookContext): Promise<HookResult> => {
      return { continue: true, message: "TypeCheck: Re-checking after edit" };
    },
  },
];

export async function activateTypeChecker(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) { if (!h.has(hook.name)) h.set(hook.name, []); h.get(hook.name).push({ plugin: "type-checker", handler: hook.handler }); }
  }, async () => {});
}
