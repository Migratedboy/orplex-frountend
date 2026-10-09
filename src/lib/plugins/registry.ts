/**
 * Plugin Registry — loads, manages, and executes Orplex plugins
 *
 * Plugins can:
 * - Add new tools to the AI
 * - Hook into tool execution (before/after)
 * - Define custom agents
 * - Respond to task lifecycle events
 */

import type { Plugin, PluginManifest, PluginTool, PluginAgent, PluginHook, HookContext, HookResult } from "./types";

// ============================================================
// Hook System
// ============================================================

export type HookName =
  | "beforeToolCall"
  | "afterToolCall"
  | "onTaskStart"
  | "onTaskComplete"
  | "onTaskFail"
  | "onFileWrite"
  | "onFileEdit"
  | "onAgentSpawn"
  | "onConsensusReached";

// ============================================================
// Plugin Registry
// ============================================================

class PluginRegistry {
  private plugins: Map<string, Plugin> = new Map();
  private hooks: Map<HookName, Array<{ plugin: string; handler: (ctx: HookContext) => Promise<HookResult> }>> = new Map();
  private tools: Map<string, PluginTool> = new Map();
  private agents: Map<string, PluginAgent> = new Map();

  // --- Plugin Management ---

  async registerPlugin(manifest: PluginManifest, activate: () => Promise<void>, deactivate: () => Promise<void>): Promise<void> {
    if (this.plugins.has(manifest.name)) {
      console.warn(`[PLUGIN] Plugin "${manifest.name}" already registered, skipping`);
      return;
    }

    const plugin: Plugin = {
      manifest,
      activate,
      deactivate,
      isActive: false,
    };

    this.plugins.set(manifest.name, plugin);
    console.log(`[PLUGIN] Registered: ${manifest.name} v${manifest.version}`);
  }

  async activatePlugin(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name);
    if (!plugin || plugin.isActive) return false;

    try {
      await plugin.activate();
      plugin.isActive = true;

      // Register hooks
      for (const hookName of plugin.manifest.hooks) {
        this.registerHook(hookName as HookName, name, plugin);
      }

      // Register tools
      if (plugin.manifest.tools) {
        for (const tool of plugin.manifest.tools) {
          this.tools.set(tool.name, tool);
        }
      }

      // Register agents
      if (plugin.manifest.agents) {
        for (const agent of plugin.manifest.agents) {
          this.agents.set(agent.role, agent);
        }
      }

      console.log(`[PLUGIN] Activated: ${name}`);
      return true;
    } catch (err) {
      console.error(`[PLUGIN] Failed to activate "${name}":`, err);
      return false;
    }
  }

  async deactivatePlugin(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name);
    if (!plugin || !plugin.isActive) return false;

    try {
      await plugin.deactivate();
      plugin.isActive = false;

      // Remove hooks
      for (const [hookName, handlers] of this.hooks) {
        this.hooks.set(hookName, handlers.filter(h => h.plugin !== name));
      }

      // Remove tools
      if (plugin.manifest.tools) {
        for (const tool of plugin.manifest.tools) {
          this.tools.delete(tool.name);
        }
      }

      // Remove agents
      if (plugin.manifest.agents) {
        for (const agent of plugin.manifest.agents) {
          this.agents.delete(agent.role);
        }
      }

      console.log(`[PLUGIN] Deactivated: ${name}`);
      return true;
    } catch (err) {
      console.error(`[PLUGIN] Failed to deactivate "${name}":`, err);
      return false;
    }
  }

  // --- Hook Execution ---

  private registerHook(hookName: HookName, pluginName: string, plugin: Plugin): void {
    if (!this.hooks.has(hookName)) {
      this.hooks.set(hookName, []);
    }
    // Hook handlers are registered via the plugin's activate function
  }

  async executeHooks(hookName: HookName, context: HookContext): Promise<HookContext> {
    const handlers = this.hooks.get(hookName) || [];
    let currentContext = { ...context };

    for (const { plugin: pluginName, handler } of handlers) {
      try {
        const result = await handler(currentContext);
        if (!result.continue) {
          console.log(`[PLUGIN] Hook "${hookName}" stopped by plugin "${pluginName}"`);
          (currentContext as any)._blocked = true;
          break;
        }
        if (result.modified) {
          currentContext = { ...currentContext, ...result.modified };
        }
        if (result.message) {
          console.log(`[PLUGIN] ${pluginName}: ${result.message}`);
        }
      } catch (err) {
        console.error(`[PLUGIN] Hook "${hookName}" failed in plugin "${pluginName}":`, err);
      }
    }

    return currentContext;
  }

  // --- Tool Access ---

  getTool(name: string): PluginTool | undefined {
    return this.tools.get(name);
  }

  getAllTools(): PluginTool[] {
    return Array.from(this.tools.values());
  }

  getToolDefinitions(): unknown[] {
    return Array.from(this.tools.values()).map(tool => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  // --- Agent Access ---

  getAgent(role: string): PluginAgent | undefined {
    return this.agents.get(role);
  }

  getAllAgents(): PluginAgent[] {
    return Array.from(this.agents.values());
  }

  // --- Stats ---

  getStats(): {
    totalPlugins: number;
    activePlugins: number;
    totalTools: number;
    totalAgents: number;
    totalHooks: number;
    pluginList: Array<{ name: string; version: string; active: boolean }>;
  } {
    const pluginArray = Array.from(this.plugins.values());
    return {
      totalPlugins: pluginArray.length,
      activePlugins: pluginArray.filter(p => p.isActive).length,
      totalTools: this.tools.size,
      totalAgents: this.agents.size,
      totalHooks: Array.from(this.hooks.values()).reduce((s, h) => s + h.length, 0),
      pluginList: pluginArray.map(p => ({
        name: p.manifest.name,
        version: p.manifest.version,
        active: p.isActive,
      })),
    };
  }
}

// Singleton
export const pluginRegistry = new PluginRegistry();

// ============================================================
// Convenience: Hook Execution Wrappers
// ============================================================

export async function beforeToolCall(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown> & { _blocked?: boolean }> {
  const ctx = await pluginRegistry.executeHooks("beforeToolCall", { tool, args });
  // Check if any hook blocked this call
  const blocked = (ctx as any)._blocked === true;
  return { ...(ctx.args || args), _blocked: blocked };
}

export async function afterToolCall(tool: string, args: Record<string, unknown>, result: string): Promise<string> {
  const ctx = await pluginRegistry.executeHooks("afterToolCall", { tool, args, result });
  return ctx.result || result;
}

export async function onTaskStart(task: string): Promise<void> {
  await pluginRegistry.executeHooks("onTaskStart", { task });
}

export async function onTaskComplete(
  task: string,
  result: string,
  extra?: { files?: Record<string, string>; lanes?: Record<string, string>; finalStatus?: string }
): Promise<void> {
  await pluginRegistry.executeHooks("onTaskComplete", { task, result, files: extra?.files, lanes: extra?.lanes, finalStatus: extra?.finalStatus });
}

export async function onTaskFail(task: string, error: string): Promise<void> {
  await pluginRegistry.executeHooks("onTaskFail", { task, error });
}

export async function onFileWrite(path: string, content: string): Promise<void> {
  await pluginRegistry.executeHooks("onFileWrite", { path, content, files: { [path]: content } });
}

export async function onFileEdit(path: string, oldText: string, newText: string): Promise<void> {
  await pluginRegistry.executeHooks("onFileEdit", { path, oldText, newText });
}
