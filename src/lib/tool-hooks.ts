// tool-hooks.ts — Minimal, config-driven tool gating for both agent loops.
//
// Claude Code's hook system is a power feature; the common needs are "never
// touch X" and "tell me when Y happens". This implements exactly those two as
// declarative rules in orplex.config.json at the workspace root:
//
//   { "toolHooks": { "deny":  ["rm\\s+-rf", "drop\\s+table"],
//                    "notify": ["run_command", "write_file"] } }
//
// deny:    regexes matched (case-insensitive) against "<tool> <args-summary>".
//          A hit BLOCKS the call — the agent sees the reason.
// notify:  tool names (or regexes) that emit a runtime event when invoked.
//
// Deliberately NOT supported: process-spawning hooks. Arbitrary per-tool-call
// exec is a risk and a RAM cost this machine doesn't need.

export interface ToolHookConfig {
  deny: string[];
  notify: string[];
}

export interface ToolHookDecision {
  blocked: boolean;
  reason?: string;
}

interface CompiledHooks {
  deny: RegExp[];
  notify: RegExp[];
  errors: string[];
}

const MAX_RULES = 50;

/** Compile + sanity-check rule arrays. Invalid rules are skipped, not fatal. */
function compile(deny: unknown, notify: unknown): CompiledHooks {
  const errors: string[] = [];
  const toRegexes = (value: unknown, label: string): RegExp[] => {
    if (!Array.isArray(value)) return [];
    return value
      .slice(0, MAX_RULES)
      .map((entry) => {
        if (typeof entry !== "string" || entry.length > 200) {
          errors.push(`invalid ${label} rule (must be a string ≤200 chars)`);
          return null;
        }
        try {
          return new RegExp(entry, "i");
        } catch {
          errors.push(`invalid ${label} regex: ${entry.slice(0, 40)}`);
          return null;
        }
      })
      .filter((r): r is RegExp => r !== null);
  };
  return {
    deny: toRegexes(deny, "deny"),
    notify: toRegexes(notify, "notify"),
    errors,
  };
}

/** Parse a raw config object into compiled hooks. Unknown fields ignored. */
export function parseToolHookConfig(config: unknown): CompiledHooks {
  const hooks = (config as { toolHooks?: { deny?: unknown; notify?: unknown } } | null)?.toolHooks;
  if (!hooks || typeof hooks !== "object") {
    return { deny: [], notify: [], errors: [] };
  }
  return compile(hooks.deny, hooks.notify);
}

function summaryOf(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (k === "name") continue;
    if (typeof v === "string") parts.push(`${k}=${v.slice(0, 120)}`);
    else if (v !== undefined && v !== null) parts.push(`${k}=${String(v).slice(0, 60)}`);
  }
  return parts.join(" ").slice(0, 400);
}

/**
 * Evaluate the deny rules against a tool call. Returns blocked + reason.
 * Cheap: a handful of regex tests, no I/O — safe on every tool call.
 */
export function evaluateDenyRules(
  hooks: CompiledHooks,
  toolName: string,
  args: Record<string, unknown>
): ToolHookDecision {
  if (hooks.deny.length === 0) return { blocked: false };
  const haystack = `${toolName} ${summaryOf(args)}`;
  for (const re of hooks.deny) {
    if (re.test(haystack)) {
      return { blocked: true, reason: `blocked by toolHooks.deny rule: /${re.source}/i` };
    }
  }
  return { blocked: false };
}

/**
 * Does this call match any notify rule? A rule matches when it hits the tool
 * NAME (so "^run_command$" means exactly that tool) or the full
 * name+args summary (so arg-based rules like "secrets" also fire).
 */
export function matchesNotifyRules(
  hooks: CompiledHooks,
  toolName: string,
  args: Record<string, unknown>
): boolean {
  if (hooks.notify.length === 0) return false;
  const haystack = `${toolName} ${summaryOf(args)}`;
  return hooks.notify.some((re) => re.test(toolName) || re.test(haystack));
}

export type { CompiledHooks };

// ── Config loading (server-side, cached per workspace) ────────────────────

const configCache = new Map<string, { hooks: CompiledHooks; loadedAt: number }>();
const CONFIG_CACHE_MS = 60_000; // config edits apply within a minute

/**
 * Load + compile hooks for a workspace directory. Cached for 60s so the
 * per-tool-call cost stays a Map lookup. Never throws — an unreadable config
 * means "no hooks", not "no agent".
 */
export async function loadToolHooks(workDir: string): Promise<CompiledHooks> {
  const cached = configCache.get(workDir);
  if (cached && Date.now() - cached.loadedAt < CONFIG_CACHE_MS) return cached.hooks;

  let hooks: CompiledHooks = { deny: [], notify: [], errors: [] };
  try {
    const { readFile } = await import("fs/promises");
    const { join } = await import("path");
    const raw = await readFile(join(workDir, "orplex.config.json"), "utf8");
    hooks = parseToolHookConfig(JSON.parse(raw));
  } catch {
    // missing / unreadable / unparseable config — no hooks
  }
  configCache.set(workDir, { hooks, loadedAt: Date.now() });
  if (configCache.size > 100) {
    // Tiny cache; drop the oldest entries rather than grow unbounded.
    const oldest = [...configCache.entries()].sort((a, b) => a[1].loadedAt - b[1].loadedAt)[0];
    if (oldest) configCache.delete(oldest[0]);
  }
  return hooks;
}

/** Test hook: clear the config cache. */
export function clearToolHookCache(): void {
  configCache.clear();
}
