/**
 * Prompt Enhancer Plugin — Detects vague prompts and suggests specifics
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "prompt-enhancer",
  version: "1.0.0",
  description: "Detects vague prompts and suggests more specific instructions",
  author: "Orplex",
  hooks: ["beforeToolCall"],
};

const VAGUE_PATTERNS = [
  { pattern: /^(hi|hello|hey|yo|sup|what's up)$/i, suggestion: "Try: 'What can you do?' or 'Build a landing page'" },
  { pattern: /^(fix it|make it work|do something)$/i, suggestion: "Describe what's broken and what you expect" },
  { pattern: /^(cool|nice|ok|good|thanks)$/i, suggestion: "Follow up with a specific task or question" },
];

let vagueCount = 0;

const hooks: PluginHook[] = [{
  name: "beforeToolCall",
  handler: async (ctx: HookContext): Promise<HookResult> => {
    const tool = ctx.tool || "";
    const args = ctx.args || {};
    const content = (args.content as string) || (args.command as string) || "";
    for (const { pattern, suggestion } of VAGUE_PATTERNS) {
      if (pattern.test(content.trim())) {
        vagueCount++;
        return { continue: true, message: `PromptEnhancer: Vague input detected — ${suggestion}` };
      }
    }
    return { continue: true };
  },
}];

export function getPromptEnhancerStats() { return { vagueInputsDetected: vagueCount }; }

export async function activatePromptEnhancer(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) { if (!h.has(hook.name)) h.set(hook.name, []); h.get(hook.name).push({ plugin: "prompt-enhancer", handler: hook.handler }); }
  }, async () => {});
}
