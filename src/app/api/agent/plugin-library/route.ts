// Plugin library API — one-click installable bundles published by the marketplace.
// GET  /api/agent/plugin-library  → library catalog + per-workspace installed flags
// POST /api/agent/plugin-library  → { slug } installs one bundle into the open workspace
//
// Library bundles go through the SAME installPlugin() path as workspace
// bundles (existing user files always win). No new install machinery.

import { NextRequest, NextResponse } from "next/server";
import { sessionUserId } from "@/lib/server-session";
import { resolveWorkspaceCwd } from "@/lib/workspace-cwd";
import { clearToolHookCache } from "@/lib/tool-hooks";
import { installPlugin } from "@/lib/plugin-bundles";
import { isBundleInstalled, materializeBundle } from "@/lib/plugin-library";
import { getMaterializedBundles } from "@/lib/marketplace-bundles";
import { isBundleEnabled, readBundleState, recordBundleInstall, setBundleEnabled } from "@/lib/plugin-library-state";

function err(msg: string, status: number) {
  return NextResponse.json({ error: msg }, { status });
}

export async function GET(request: NextRequest) {
  const userId = await sessionUserId(request);
  if (!userId) return err("Unauthorized", 401);

  const cwd = await resolveWorkspaceCwd(userId);
  if (!cwd) return NextResponse.json({ library: [], workspaceOpen: false });

  const state = await readBundleState(cwd);
  // Bundle definitions are marketplace data — the app ships none of its own.
  const bundles = await getMaterializedBundles();
  const library = [];
  for (const b of bundles) {
    const installed = await isBundleInstalled(bundles, cwd, b.slug);
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
  const userId = await sessionUserId(request);
  if (!userId) return err("Unauthorized", 401);

  const cwd = await resolveWorkspaceCwd(userId);
  if (!cwd) return err("No workspace folder is open", 400);

  const body = await request.json().catch(() => ({}));
  const slug = typeof body?.slug === "string" ? body.slug : "";
  const bundles = await getMaterializedBundles();
  const bundle = materializeBundle(bundles, slug);
  if (!bundle) return err("Unknown library bundle", 404);

  // Containment is structural: installPlugin() writes only under
  // <workspace>/.orplex/ with sanitized skill names, so no path input from
  // this request can escape the workspace.
  const result = await installPlugin(bundle, cwd);
  await recordBundleInstall(bundles, cwd, slug); // enabled=true + rules snapshot
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
  const userId = await sessionUserId(request);
  if (!userId) return err("Unauthorized", 401);

  const cwd = await resolveWorkspaceCwd(userId);
  if (!cwd) return err("No workspace folder is open", 400);

  const body = await request.json().catch(() => ({}));
  const slug = typeof body?.slug === "string" ? body.slug : "";
  if (typeof body?.enabled !== "boolean") return err("enabled (boolean) is required", 400);

  const bundles = await getMaterializedBundles();
  const entry = await setBundleEnabled(bundles, cwd, slug, body.enabled);
  if (!entry) return err("Unknown library bundle", 404);

  // Enforcement compiles through a 60s cache — the toggle must not be stale
  // for a minute after the user flips it.
  clearToolHookCache();
  return NextResponse.json({ slug, enabled: entry.enabled, rules: entry.rules ?? null });
}
