// plugin-library/types.ts — Shared shapes for the built-in bundle library.
// Category files export plain BundleDef arrays; plugin-library.ts
// materializes them into installable ParsedPlugin units.

export type PluginCategory = "quality" | "security" | "devops" | "domain" | "intelligence";

export interface SkillDef {
  name: string;
  body: string;
}

export interface BundleDef {
  slug: string;
  category: PluginCategory;
  version: string;
  description: string;
  skills: SkillDef[];
  /** Raw deny/notify hook rules — compiled by parseToolHookConfig at load. */
  hooks?: Record<string, string[]>;
  mcp?: Record<string, unknown>;
}

export interface LibraryBundle {
  slug: string;
  category: PluginCategory;
  version: string;
  description: string;
  bundle: {
    manifest: { name: string; version: string; description: string };
    rootDir: string;
    skills: SkillDef[];
    hooks: unknown;
    mcp: unknown;
    warnings: string[];
  };
}

/** Standard skill header: title + one-line blurb, then the caller's rules. */
export const SKILL_HEADER = (title: string, blurb: string): string =>
  `# ${title}\n\n${blurb}\n\n---\n`;
