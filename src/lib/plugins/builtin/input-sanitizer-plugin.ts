/**
 * Input Sanitizer Plugin — Sanitizes shell command arguments
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "input-sanitizer",
  version: "1.0.0",
  description: "Sanitizes user input before passing to shell commands",
  author: "Orplex",
  hooks: ["beforeToolCall"],
};

const BLOCKED = ["rm -rf /", "rm -rf ~", "sudo rm", "mkfs", "dd if=", "shutdown", "reboot", ":(){ :|:& };:"];

const hooks: PluginHook[] = [{
  name: "beforeToolCall",
  handler: async (ctx: HookContext): Promise<HookResult> => {
    if (ctx.tool !== "run_command") return { continue: true };
    const cmd = (ctx.args?.command as string) || "";
    for (const b of BLOCKED) {
      if (cmd.toLowerCase().includes(b)) {
        return { continue: false, message: `BLOCKED: Dangerous command: ${b}` };
      }
    }
    return { continue: true };
  },
}];

export async function activateInputSanitizer(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) {
      if (!h.has(hook.name)) h.set(hook.name, []);
      h.get(hook.name).push({ plugin: "input-sanitizer", handler: hook.handler });
    }
  }, async () => {});
}
