/**
 * Server-side plugin middleware — protects API routes
 */
import { pluginRegistry } from "./registry";

export async function serverBeforeToolCall(tool: string, args: Record<string, unknown>): Promise<{ blocked: boolean; reason?: string }> {
  const ctx = await pluginRegistry.executeHooks("beforeToolCall", { tool, args });
  if ((ctx as any)._blocked) {
    return { blocked: true, reason: "Blocked by plugin" };
  }
  return { blocked: false };
}

export async function serverAfterToolCall(tool: string, args: Record<string, unknown>, result: string): Promise<void> {
  await pluginRegistry.executeHooks("afterToolCall", { tool, args, result });
}

export async function serverOnFileWrite(path: string, content: string): Promise<void> {
  await pluginRegistry.executeHooks("onFileWrite", { path, content, files: { [path]: content } });
}
