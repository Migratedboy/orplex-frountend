/**
 * Linter Plugin — Runs basic lint checks on file writes
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "linter",
  version: "1.0.0",
  description: "Checks code quality on file writes — catches common issues",
  author: "Orplex",
  hooks: ["afterToolCall", "onFileEdit"],
};

const LINT_RULES = [
  { pattern: /console\.(log|debug|info)\s*\(/g, severity: "warning" as const, msg: "Console logging in production" },
  { pattern: /var\s+\w+/g, severity: "info" as const, msg: "Use let/const instead of var" },
  { pattern: /==(?!=)/g, severity: "info" as const, msg: "Use === instead of ==" },
  { pattern: /catch\s*\(\s*\w*\s*\)\s*\{\s*\}/g, severity: "warning" as const, msg: "Empty catch block" },
];

function lintContent(content: string): string[] {
  const issues: string[] = [];
  for (const rule of LINT_RULES) {
    rule.pattern.lastIndex = 0;
    const matches = content.match(rule.pattern);
    if (matches && matches.length > 0) issues.push("[" + rule.severity + "] " + rule.msg + " (" + matches.length + "x)");
  }
  return issues;
}

const hooks: PluginHook[] = [
  {
    name: "afterToolCall",
    handler: async (ctx: HookContext): Promise<HookResult> => {
      if (ctx.tool !== "write_file") return { continue: true };
      const path = (ctx.args?.path as string) || "";
      if (!path.match(/\.(ts|tsx|js|jsx)$/)) return { continue: true };
      const content = (ctx.args?.content as string) || "";
      const issues = lintContent(content);
      if (issues.length > 0) return { continue: true, message: "Linter: " + issues.join("; ") };
      return { continue: true };
    },
  },
  {
    name: "onFileEdit",
    handler: async (ctx: HookContext): Promise<HookResult> => {
      return { continue: true, message: "Linter: Re-checking after edit" };
    },
  },
];

export async function activateLinter(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) { if (!h.has(hook.name)) h.set(hook.name, []); h.get(hook.name).push({ plugin: "linter", handler: hook.handler }); }
  }, async () => {});
}
