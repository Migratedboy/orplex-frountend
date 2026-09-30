/**
 * Secret Scanner Plugin — Blocks hardcoded secrets in file writes
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "secret-scanner",
  version: "1.0.0",
  description: "Blocks file writes containing hardcoded API keys, passwords, and tokens",
  author: "Orplex",
  hooks: ["beforeToolCall"],
};

const SECRET_PATTERNS = [
  { pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*["'][A-Za-z0-9_\-]{20,}["']/gi, type: "API Key" },
  { pattern: /(?:password|passwd|pwd)\s*[=:]\s*["'][^"']{8,}["']/gi, type: "Password" },
  { pattern: /(?:secret|secret[_-]?key)\s*[=:]\s*["'][A-Za-z0-9_\-]{16,}["']/gi, type: "Secret" },
  { pattern: /(?:token|access[_-]?token|auth[_-]?token)\s*[=:]\s*["'][A-Za-z0-9_\-\.]{20,}["']/gi, type: "Token" },
  { pattern: /(?:sk_live|pk_live|sk_test|pk_test)[A-Za-z0-9_]{20,}/g, type: "Stripe Key" },
  { pattern: /ghp_[A-Za-z0-9_]{36}/g, type: "GitHub Token" },
  { pattern: /xox[bpsa]-[A-Za-z0-9\-]{10,}/g, type: "Slack Token" },
  { pattern: /AIza[A-Za-z0-9_\-]{35}/g, type: "Google API Key" },
  { pattern: /(?:AWS_SECRET_ACCESS_KEY|aws_secret_access_key)\s*[=:]\s*["'][A-Za-z0-9/+=]{40}["']/gi, type: "AWS Secret" },
];

const hooks: PluginHook[] = [
  {
    name: "beforeToolCall",
    handler: async (ctx: HookContext): Promise<HookResult> => {
      if (ctx.tool !== "write_file" && ctx.tool !== "edit_file") return { continue: true };
      const content = (ctx.args?.content as string) || (ctx.args?.new_text as string) || "";
      if (!content) return { continue: true };

      const found: string[] = [];
      for (const { pattern, type } of SECRET_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(content)) found.push(type);
      }

      if (found.length > 0) {
        return {
          continue: false,
          message: `BLOCKED: Detected ${found.join(", ")} in file content. Use environment variables instead.`,
        };
      }
      return { continue: true };
    },
  },
];

export async function activateSecretScanner(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const hookHandlers = (pluginRegistry as any).hooks;
    for (const hook of hooks) {
      if (!hookHandlers.has(hook.name)) hookHandlers.set(hook.name, []);
      hookHandlers.get(hook.name).push({ plugin: "secret-scanner", handler: hook.handler });
    }
  }, async () => {});
}
