// Plugin bundles API — discover + install skills/hooks/MCP bundles.
// GET  /api/agent/plugins           → bundles found in the workspace (preview)
// POST /api/agent/plugins           → install: { pluginDir } installs one, no body installs all

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { getWorkspaceCwd } from "@/lib/workspace-cwd";
import { discoverPlugins, installPlugin } from "@/lib/plugin-bundles";

export async function GET() {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const cwd = getWorkspaceCwd((session.user as { id?: string }).id || "");
    if (!cwd) {
      return NextResponse.json({ plugins: [] });
    }
    const plugins = await discoverPlugins(cwd);

    return NextResponse.json({
      plugins: plugins.map((p) => ({
        name: p.manifest.name,
        version: p.manifest.version ?? null,
        description: p.manifest.description ?? null,
        dir: p.rootDir,
        skillCount: p.skills.length,
        hasHooks: p.hooks !== undefined,
        hasMcp: p.mcp !== undefined,
        warnings: p.warnings,
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: "Failed to scan for plugins" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const cwd = getWorkspaceCwd((session.user as { id?: string }).id || "");
    if (!cwd) {
      return NextResponse.json({ error: "No workspace folder is open" }, { status: 400 });
    }
    const body = await request.json().catch(() => ({}));
    const targetDir = typeof body?.pluginDir === "string" ? body.pluginDir : null;

    const plugins = (await discoverPlugins(cwd)).filter(
      (p) => !targetDir || p.rootDir === targetDir
    );

    if (plugins.length === 0) {
      return NextResponse.json(
        { error: targetDir ? "Plugin not found" : "No plugin bundles found in workspace" },
        { status: 404 }
      );
    }

    const results = [];
    for (const plugin of plugins) {
      const r = await installPlugin(plugin, cwd);
      results.push({ name: plugin.manifest.name, ...r });
    }

    return NextResponse.json({ installed: results });
  } catch (err) {
    return NextResponse.json({ error: "Failed to install plugin" }, { status: 500 });
  }
}
