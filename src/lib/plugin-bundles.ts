// Plugin bundles — install skills + hooks + MCP servers as ONE unit.
// Inspired by Claude Code plugins: drop a folder (or a single .orplex-plugin.json)
// into the workspace and Orplex merges every piece into the right location:
//   <bundle>/skills/<name>/SKILL.md      → .orplex/skills/<name>/SKILL.md
//   <bundle>/hooks.json                  → merged into .orplex/hooks.json
//   <bundle>/mcp.json                    → merged into .orplex/mcp.json
// Bundles are data-only (no executable plugin code) — same trust model as the
// underlying skills/hooks/MCP files themselves.

import { readFile, writeFile, readdir, mkdir, access } from "node:fs/promises";
import { join } from "node:path";

export const PLUGIN_MANIFEST = "orplex-plugin.json";
export const MAX_PLUGIN_SKILLS = 32;
export const MAX_HOOK_ENTRIES = 20;
export const MAX_HOOK_COMMAND_CHARS = 500;

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
}

export interface ParsedPlugin {
  manifest: PluginManifest;
  rootDir: string;
  skills: Array<{ name: string; body: string }>;
  hooks: unknown; // shape-validated by parseUserHooks at load time
  mcp: unknown; // shape-validated by loadMcpConfig at load time
  warnings: string[];
}

function exists(p: string): Promise<boolean> {
  return access(p)
    .then(() => true)
    .catch(() => false);
}

/** Locate a plugin root: the dir itself, or any direct child holding a manifest. */
export async function findPluginRoots(rootDir: string): Promise<string[]> {
  const found: string[] = [];
  if (await exists(join(rootDir, PLUGIN_MANIFEST))) {
    found.push(rootDir);
  }
  let children: string[] = [];
  try {
    children = (await readdir(rootDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return found;
  }
  for (const child of children) {
    if (await exists(join(rootDir, child, PLUGIN_MANIFEST))) {
      found.push(join(rootDir, child));
    }
  }
  return found;
}

/** Parse one bundle directory: manifest + skills + hooks + mcp, all optional. */
export async function parsePlugin(pluginDir: string): Promise<ParsedPlugin> {
  const warnings: string[] = [];
  const manifestPath = join(pluginDir, PLUGIN_MANIFEST);

  let manifest: PluginManifest = { name: pluginDir.split(/[\\/]/).pop() || "plugin" };
  try {
    const raw = JSON.parse(await readFile(manifestPath, "utf8"));
    if (raw && typeof raw.name === "string" && raw.name.trim()) {
      manifest = {
        name: raw.name.trim().slice(0, 64),
        ...(typeof raw.version === "string" ? { version: raw.version.slice(0, 32) } : {}),
        ...(typeof raw.description === "string" ? { description: raw.description.slice(0, 200) } : {}),
      };
    } else {
      warnings.push("manifest missing valid 'name' — using folder name");
    }
  } catch {
    warnings.push("unreadable or missing manifest — using folder name");
  }

  // Skills: every subdirectory of skills/ with a SKILL.md
  const skills: Array<{ name: string; body: string }> = [];
  const skillsDir = join(pluginDir, "skills");
  if (await exists(skillsDir)) {
    try {
      const entries = await readdir(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillFile = join(skillsDir, entry.name, "SKILL.md");
        if (!(await exists(skillFile))) continue;
        if (skills.length >= MAX_PLUGIN_SKILLS) {
          warnings.push(`skill cap (${MAX_PLUGIN_SKILLS}) reached — skipping '${entry.name}'`);
          break;
        }
        const body = await readFile(skillFile, "utf8");
        skills.push({ name: entry.name, body });
      }
    } catch {
      warnings.push("skills/ directory unreadable");
    }
  }

  // Hooks: raw JSON — validated later by parseUserHooks on load.
  let hooks: unknown;
  const hooksPath = join(pluginDir, "hooks.json");
  if (await exists(hooksPath)) {
    try {
      hooks = JSON.parse(await readFile(hooksPath, "utf8"));
    } catch {
      warnings.push("hooks.json is not valid JSON — skipped");
    }
  }

  // MCP servers: raw JSON — validated later by loadMcpConfig.
  let mcp: unknown;
  const mcpPath = join(pluginDir, "mcp.json");
  if (await exists(mcpPath)) {
    try {
      mcp = JSON.parse(await readFile(mcpPath, "utf8"));
    } catch {
      warnings.push("mcp.json is not valid JSON — skipped");
    }
  }

  return { manifest, rootDir: pluginDir, skills, hooks, mcp, warnings };
}

/**
 * Install a parsed bundle into the workspace's .orplex/ tree.
 * Existing user files win on conflict — the bundle's pieces are only added
 * when the target doesn't already provide them (skills by name, hooks by
 * event+match, MCP by server name).
 */
export async function installPlugin(
  plugin: ParsedPlugin,
  workspaceRoot: string
): Promise<{ installedSkills: string[]; mergedHooks: number; mergedMcp: number; warnings: string[] }> {
  const orplexDir = join(workspaceRoot, ".orplex");
  await mkdir(orplexDir, { recursive: true });
  const warnings = [...plugin.warnings];
  const installedSkills: string[] = [];

  // --- Skills ---
  if (plugin.skills.length > 0) {
    const destSkills = join(orplexDir, "skills");
    await mkdir(destSkills, { recursive: true });
    for (const skill of plugin.skills) {
      const safeName = skill.name.replace(/[^\w.-]/g, "_").slice(0, 64);
      const skillDir = join(destSkills, safeName);
      const skillFile = join(skillDir, "SKILL.md");
      if (await exists(skillFile)) {
        warnings.push(`skill '${safeName}' already exists — kept user version`);
        continue;
      }
      await mkdir(skillDir, { recursive: true });
      await writeFile(skillFile, skill.body, "utf8");
      installedSkills.push(safeName);
    }
  }

  // --- Hooks (event-keyed shallow merge, existing entries win) ---
  let mergedHooks = 0;
  if (plugin.hooks && typeof plugin.hooks === "object") {
    const hooksFile = join(orplexDir, "hooks.json");
    let existing: Record<string, unknown[]> = {};
    try {
      existing = JSON.parse(await readFile(hooksFile, "utf8"));
    } catch {
      // start fresh — a corrupt user file must not block install
    }
    const incoming = plugin.hooks as Record<string, unknown>;
    let total = Object.values(existing).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
    for (const [event, entries] of Object.entries(incoming)) {
      if (!Array.isArray(entries)) continue;
      if (!existing[event]) existing[event] = [];
      for (const entry of entries) {
        if (total >= MAX_HOOK_ENTRIES) {
          warnings.push(`hooks cap (${MAX_HOOK_ENTRIES}) reached — some entries skipped`);
          break;
        }
        existing[event].push(entry);
        total++;
        mergedHooks++;
      }
    }
    await writeFile(hooksFile, JSON.stringify(existing, null, 2), "utf8");
  }

  // --- MCP servers (name-keyed, existing servers win) ---
  let mergedMcp = 0;
  if (plugin.mcp && typeof plugin.mcp === "object") {
    const mcpFile = join(orplexDir, "mcp.json");
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await readFile(mcpFile, "utf8"));
    } catch {
      // start fresh
    }
    for (const [server, config] of Object.entries(plugin.mcp as Record<string, unknown>)) {
      if (existing[server]) {
        warnings.push(`mcp server '${server}' already exists — kept user version`);
        continue;
      }
      existing[server] = config;
      mergedMcp++;
    }
    await writeFile(mcpFile, JSON.stringify(existing, null, 2), "utf8");
  }

  return { installedSkills, mergedHooks, mergedMcp, warnings };
}

/** Scan a workspace for bundles and parse them (no install). */
export async function discoverPlugins(rootDir: string): Promise<ParsedPlugin[]> {
  const roots = await findPluginRoots(rootDir);
  const parsed: ParsedPlugin[] = [];
  for (const root of roots) {
    try {
      parsed.push(await parsePlugin(root));
    } catch {
      // a broken bundle must not break discovery of the others
    }
  }
  return parsed;
}
