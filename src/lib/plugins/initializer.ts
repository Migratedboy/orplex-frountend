/**
 * Plugin Initializer — Activates all plugins on startup
 */

import { pluginRegistry } from "./registry";

// Core
import { activateLogger } from "./builtin/logger-plugin";
import { activateMemorySync } from "./builtin/memory-sync-plugin";
import { activateCostTracker } from "./builtin/cost-tracker-plugin";
import { activateModelRouterConfig } from "./builtin/model-router-config-plugin";
import { activateTaskQueue } from "./builtin/task-queue-plugin";
import { activateExportManager } from "./builtin/export-manager-plugin";

// Quality
import { activateTestgen } from "./builtin/testgen-plugin";
import { activateLinter } from "./builtin/linter-plugin";
import { activateTypeChecker } from "./builtin/type-checker-plugin";
import { activateDocGen } from "./builtin/doc-gen-plugin";
import { activateCodeReview } from "./builtin/code-review-plugin";

// Intelligence
import { activatePromptEnhancer } from "./builtin/prompt-enhancer-plugin";
import { activateResponseCache } from "./builtin/response-cache-plugin";
import { activatePatternLearner } from "./builtin/pattern-learner-plugin";
import { activateComplexityEstimator } from "./builtin/complexity-estimator-plugin";

// Security
import { activateSecretScanner } from "./builtin/secret-scanner-plugin";
import { activatePathTraversal } from "./builtin/path-traversal-plugin";
import { activateInputSanitizer } from "./builtin/input-sanitizer-plugin";

// DevOps
import { activateGitAutoCommit } from "./builtin/git-auto-commit-plugin";
import { activateBuildWatcher } from "./builtin/build-watcher-plugin";
import { activateDepUpdater } from "./builtin/dep-updater-plugin";
import { activateDockerScaffold } from "./builtin/docker-scaffold-plugin";

// Domain
import { activateUIComponents } from "./builtin/ui-components-plugin";
import { activateAPIScaffold } from "./builtin/api-scaffold-plugin";
import { activateDBMigration } from "./builtin/db-migration-plugin";

export interface PluginEntry {
  name: string;
  category: "core" | "quality" | "intelligence" | "security" | "devops" | "domain";
  description: string;
  activate: () => Promise<void>;
}

export const PLUGIN_REGISTRY: PluginEntry[] = [
  // Core
  { name: "logger", category: "core", description: "Logs all tool calls and tracks usage statistics", activate: activateLogger },
  { name: "memory-sync", category: "core", description: "Persists learning memory across sessions via localStorage", activate: activateMemorySync },
  { name: "cost-tracker", category: "core", description: "Tracks API costs, shows daily/weekly/monthly spend by tier", activate: activateCostTracker },
  { name: "model-router-config", category: "core", description: "Configurable tier routing — override model selection per task type", activate: activateModelRouterConfig },
  { name: "task-queue", category: "core", description: "Queues tasks when rate-limited, auto-retries after cooldown", activate: activateTaskQueue },
  { name: "export-manager", category: "core", description: "Enhanced .zip export with .gitignore filtering and folder structure", activate: activateExportManager },
  // Quality
  { name: "testgen", category: "quality", description: "Auto-generates test file stubs when new modules are created", activate: activateTestgen },
  { name: "linter", category: "quality", description: "Checks code quality on file writes — catches common issues", activate: activateLinter },
  { name: "type-checker", category: "quality", description: "Reports TypeScript type issues after file changes", activate: activateTypeChecker },
  { name: "doc-gen", category: "quality", description: "Auto-generates JSDoc documentation for exported functions", activate: activateDocGen },
  { name: "code-review", category: "quality", description: "Reviews code quality on every file write — catches issues early", activate: activateCodeReview },
  // Intelligence
  { name: "prompt-enhancer", category: "intelligence", description: "Enriches vague prompts with best practices before sending to model", activate: activatePromptEnhancer },
  { name: "response-cache", category: "intelligence", description: "Caches identical prompts, returns cached response instantly", activate: activateResponseCache },
  { name: "pattern-learner", category: "intelligence", description: "Records successful tool sequences, suggests them for similar tasks", activate: activatePatternLearner },
  { name: "complexity-estimator", category: "intelligence", description: "Pre-computes task complexity, routes to optimal model tier", activate: activateComplexityEstimator },
  // Security
  { name: "secret-scanner", category: "security", description: "Blocks file writes containing hardcoded API keys, passwords, and tokens", activate: activateSecretScanner },
  { name: "path-traversal", category: "security", description: "Prevents file writes outside the workspace directory", activate: activatePathTraversal },
  { name: "input-sanitizer", category: "security", description: "Sanitizes user input before passing to shell commands", activate: activateInputSanitizer },
  // DevOps
  { name: "git-auto-commit", category: "devops", description: "Auto-commits file changes with descriptive messages", activate: activateGitAutoCommit },
  { name: "build-watcher", category: "devops", description: "Runs npm build after file changes, reports errors", activate: activateBuildWatcher },
  { name: "dep-updater", category: "devops", description: "Checks for outdated dependencies, suggests updates", activate: activateDepUpdater },
  { name: "docker-scaffold", category: "devops", description: "Auto-generates Dockerfile and docker-compose.yml", activate: activateDockerScaffold },
  // Domain
  { name: "ui-components", category: "domain", description: "Generates Tailwind/shadcn components with consistent styling", activate: activateUIComponents },
  { name: "api-scaffold", category: "domain", description: "Generates REST/GraphQL API routes from schema definitions", activate: activateAPIScaffold },
  { name: "db-migration", category: "domain", description: "Generates Prisma migrations from schema changes", activate: activateDBMigration },
];

// Default enabled plugins
const DEFAULT_ENABLED = ["logger", "secret-scanner", "input-sanitizer", "linter", "cost-tracker", "memory-sync", "testgen", "type-checker"];

// Load from localStorage if available
function loadPluginState(): Set<string> {
  try {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("orplex:enabled-plugins");
      if (saved) return new Set(JSON.parse(saved));
    }
  } catch {}
  return new Set(DEFAULT_ENABLED);
}

function savePluginState(): void {
  try {
    if (typeof window !== "undefined") {
      localStorage.setItem("orplex:enabled-plugins", JSON.stringify([...enabledPlugins]));
    }
  } catch {}
}

let enabledPlugins = loadPluginState();

export function getEnabledPlugins(): Set<string> { return enabledPlugins; }
export function enablePlugin(name: string) { enabledPlugins.add(name); savePluginState(); }
export function disablePlugin(name: string) { enabledPlugins.delete(name); savePluginState(); }
export function isPluginEnabled(name: string): boolean { return enabledPlugins.has(name); }

export async function initializePlugins(): Promise<void> {
  console.log("[PLUGINS] Initializing...");
  let activated = 0;
  for (const entry of PLUGIN_REGISTRY) {
    if (enabledPlugins.has(entry.name)) {
      try {
        await entry.activate();
        await pluginRegistry.activatePlugin(entry.name);
        activated++;
      } catch (err) {
        console.error(`[PLUGINS] Failed to activate ${entry.name}:`, err);
      }
    }
  }
  console.log(`[PLUGINS] ${activated}/${PLUGIN_REGISTRY.length} plugins activated`);
}
