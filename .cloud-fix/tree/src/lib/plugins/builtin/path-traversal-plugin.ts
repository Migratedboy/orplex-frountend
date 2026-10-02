/**
 * Path Traversal Plugin — Prevents writes outside the workspace
 */
import type { PluginManifest, PluginHook, HookContext, HookResult } from "../types";
import { pluginRegistry } from "../registry";

const manifest: PluginManifest = {
  name: "path-traversal",
  version: "1.0.0",
  description: "Prevents file writes outside the workspace directory",
  author: "Orplex",
  hooks: ["beforeToolCall"],
};

let workspaceRoot = "";

export function setWorkspaceRoot(root: string) { workspaceRoot = root; }

const hooks: PluginHook[] = [{
  name: "beforeToolCall",
  handler: async (ctx: HookContext): Promise<HookResult> => {
    if (ctx.tool !== "write_file" && ctx.tool !== "edit_file" && ctx.tool !== "read_file") return { continue: true };
    const filePath = (ctx.args?.path as string) || "";
    if (!filePath || !workspaceRoot) return { continue: true };
    const normalized = filePath.replace(/\\\\/g, "/");
    if (normalized.includes("..") || normalized.startsWith("/")) {
      return { continue: false, message: `BLOCKED: Path traversal detected: ${filePath}` };
    }
    return { continue: true };
  },
}];

export async function activatePathTraversal(): Promise<void> {
  await pluginRegistry.registerPlugin(manifest, async () => {
    const h = (pluginRegistry as any).hooks;
    for (const hook of hooks) {
      if (!h.has(hook.name)) h.set(hook.name, []);
      h.get(hook.name).push({ plugin: "path-traversal", handler: hook.handler });
    }
  }, async () => {});
}
