/**
 * Plugin type definitions for Orplex
 */

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  hooks: string[];           // Which hooks this plugin listens to
  tools?: PluginTool[];      // Tools this plugin provides
  agents?: PluginAgent[];    // Agents this plugin defines
  config?: Record<string, unknown>; // Plugin configuration
}

export interface PluginTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>) => Promise<string>;
}

export interface PluginAgent {
  role: string;
  systemPrompt: string;
  tools: string[];
  maxTokens: number;
}

export interface PluginHook {
  name: string;
  handler: (context: HookContext) => Promise<HookResult>;
}

export interface HookContext {
  tool?: string;
  args?: Record<string, unknown>;
  result?: string;
  task?: string;
  files?: Record<string, string>;
  [key: string]: unknown;
}

export interface HookResult {
  continue: boolean;         // Should the next hook/execution continue?
  modified?: {
    args?: Record<string, unknown>;
    result?: string;
  };
  message?: string;
}

export interface Plugin {
  manifest: PluginManifest;
  activate: () => Promise<void>;
  deactivate: () => Promise<void>;
  isActive: boolean;
}
