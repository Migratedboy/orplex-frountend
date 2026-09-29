// Plugin library API — built-in, one-click installable bundles.
// GET  /api/agent/plugin-library  → library catalog + per-workspace installed flags
// POST /api/agent/plugin-library  → { slug } installs one bundle into the open workspace
//
// Library bundles go through the SAME installPlugin() path as workspace
// bundles (existing user files always win). No new install machinery.

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { getWorkspaceCwd } from "@/lib/workspace-cwd";
import { clearToolHookCache } from "@/lib/tool-hooks";
import { installPlugin } from "@/lib/plugin-bundles";
import { BUILTIN_BUNDLES, isBundleInstalled, materializeBundle } from "@/lib/plugin-library";
import { isBundleEnabled, readBundleState, recordBundleInstall, setBundleEnabled } from "@/lib/plugin-library-state";

function err(msg: string, status: number) {
  return NextResponse.json({ error: msg }, { status });
}

export async function GET() {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user) return err("Unauthorized", 401);

  const userId = (session.user as { id?: string }).id || "";
  const cwd = getWorkspaceCwd(userId);
  if (!cwd) return NextResponse.json({ library: [], workspaceOpen: false });

  const state = await readBundleState(cwd);
  const library = [];
  for (const b of BUILTIN_BUNDLES) {
    const installed = await isBundleInstalled(cwd, b.slug);
    library.push({
      slug: b.slug,
      name: b.slug,
      category: b.category,
      version: b.version,
      description: b.description,
      skillCount: b.bundle.skills.length,
      hasHooks: b.bundle.hooks !== undefined,
      hasMcp: b.bundle.mcp !== undefined,
      installed,
      // Display flag: installed + no state entry → enabled (default on).
      enabled: installed ? state[b.slug]?.enabled !== false : null,
    });
  }
  return NextResponse.json({ library, workspaceOpen: true });
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user) return err("Unauthorized", 401);

  const userId = (session.user as { id?: string }).id || "";
  const cwd = getWorkspaceCwd(userId);
  if (!cwd) return err("No workspace folder is open", 400);

  const body = await request.json().catch(() => ({}));
  const slug = typeof body?.slug === "string" ? body.slug : "";
  const bundle = materializeBundle(slug);
  if (!bundle) return err("Unknown library bundle", 404);

  // Containment is structural: installPlugin() writes only under
  // <workspace>/.orplex/ with sanitized skill names, so no path input from
  // this request can escape the workspace.
  const result = await installPlugin(bundle, cwd);
  await recordBundleInstall(cwd, slug); // enabled=true + rules snapshot
  return NextResponse.json({
    installed: {
      name: bundle.manifest.name,
      ...result,
    },
  });
}

// PATCH — flip a bundle's hook enforcement on/off without touching its files.
// Body: { slug, enabled } → new state entry.
export async function PATCH(request: NextRequest) {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user) return err("Unauthorized", 401);

  const cwd = getWorkspaceCwd((session.user as { id?: string }).id || "");
  if (!cwd) return err("No workspace folder is open", 400);

  const body = await request.json().catch(() => ({}));
  const slug = typeof body?.slug === "string" ? body.slug : "";
  if (typeof body?.enabled !== "boolean") return err("enabled (boolean) is required", 400);

  const entry = await setBundleEnabled(cwd, slug, body.enabled);
  if (!entry) return err("Unknown library bundle", 404);

  // Enforcement compiles through a 60s cache — the toggle must not be stale
  // for a minute after the user flips it.
  clearToolHookCache();
  return NextResponse.json({ slug, enabled: entry.enabled, rules: entry.rules ?? null });
}
