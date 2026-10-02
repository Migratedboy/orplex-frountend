/**
 * Dependency Updater Plugin — Detects outdated package patterns
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "dep-updater",
  version: "1.0.0",
  description: "Detects outdated dependency patterns in code",
  author: "Orplex",
  hooks: ["afterToolCall"],
};

const OUTDATED_PATTERNS = [
  { pattern: /require\(["']react["']\)/g, msg: "Using CommonJS require — consider ES modules import" },
  { pattern: /var\s+React\s*=\s*require/g, msg: "Old React pattern — use import React from 'react'" },
  { pattern: /\.then\(\s*function\s*\(/g, msg: "Anonymous function in .then — use arrow function" },
];

const hooks: PluginHook[] = [{
  name: "afterToolCall",
  handler: async (ctx: HookContext): Promise<HookResult> => {
    if (ctx.tool !== "write_file") return { continue: true };
    const content = (ctx.args?.content as string) || "";
    const issues: string[] = [];
    for (const { pattern, msg } of OUTDATED_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) issues.push(msg);
    }
    if (issues.length > 0) return { continue: true, message: `DepUpdater: ${issues.join("; ")}` };
    return { continue: true };
  },
}];

export async function activateDepUpdater(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) { if (!h.has(hook.name)) h.set(hook.name, []); h.get(hook.name).push({ plugin: "dep-updater", handler: hook.handler }); }
  }, async () => {});
}
