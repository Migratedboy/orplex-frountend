// plugin-library.ts — Built-in plugin bundle library: the public surface.
// Bundle definitions live in plugin-library/ (one file per category); this
// module materializes them into installable units for the SAME installPlugin()
// path workspace bundles use (existing user files always win). A bundle is
// "installed" when its first skill exists in the workspace — content-based,
// so a bundle installed by hand still shows green.

import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ParsedPlugin } from "./plugin-bundles";
import { QUALITY_BUNDLES } from "./plugin-library/quality";
import { SECURITY_BUNDLES } from "./plugin-library/security";
import { DEVOPS_BUNDLES } from "./plugin-library/devops";
import { DOMAIN_BUNDLES } from "./plugin-library/domain";
import { INTELLIGENCE_BUNDLES } from "./plugin-library/intelligence";
import type { BundleDef, LibraryBundle, PluginCategory } from "./plugin-library/types";

export type { PluginCategory } from "./plugin-library/types";

/** All built-in bundles, in category order (quality → intelligence). */
export const BUILTIN_BUNDLES: LibraryBundle[] = [
  ...QUALITY_BUNDLES,
  ...SECURITY_BUNDLES,
  ...DEVOPS_BUNDLES,
  ...DOMAIN_BUNDLES,
  ...INTELLIGENCE_BUNDLES,
].map(materialize);

function materialize(def: BundleDef): LibraryBundle {
  return {
    slug: def.slug,
    category: def.category,
    version: def.version,
    description: def.description,
    bundle: {
      manifest: { name: def.slug, version: def.version, description: def.description },
      rootDir: `builtin:${def.slug}`,
      skills: def.skills,
      hooks: (def.hooks ?? undefined) as unknown,
      mcp: (def.mcp ?? undefined) as unknown,
      warnings: [],
    },
  };
}

/** Materialize a library slug, or null if unknown. */
export function materializeBundle(slug: string): ParsedPlugin | null {
  const entry = BUILTIN_BUNDLES.find((b) => b.slug === slug);
  return entry ? entry.bundle : null;
}

/**
 * Is this bundle already installed in the workspace? Content-based: the
 * bundle's first skill existing under .orplex/skills/ means yes.
 */
export async function isBundleInstalled(workspaceRoot: string, slug: string): Promise<boolean> {
  const entry = BUILTIN_BUNDLES.find((b) => b.slug === slug);
  if (!entry || entry.bundle.skills.length === 0) return false;
  const first = entry.bundle.skills[0].name.replace(/[^\w.-]/g, "_").slice(0, 64);
  try {
    await access(join(workspaceRoot, ".orplex", "skills", first, "SKILL.md"));
    return true;
  } catch {
    return false;
  }
}

/** Library listing for the API/UI (no fs access needed for the catalog itself). */
export function listLibrary(): Array<{
  slug: string;
  name: string;
  category: PluginCategory;
  version: string;
  description: string;
  skillCount: number;
  hasHooks: boolean;
  hasMcp: boolean;
}> {
  return BUILTIN_BUNDLES.map((b) => ({
    slug: b.slug,
    name: b.slug,
    category: b.category,
    version: b.version,
    description: b.description,
    skillCount: b.bundle.skills.length,
    hasHooks: b.bundle.hooks !== undefined,
    hasMcp: b.bundle.mcp !== undefined,
  }));
}
