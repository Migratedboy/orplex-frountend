// tool-hooks — the CHAT lane's read of the workspace's compiled deny rules.
//
// GET /api/agent/tool-hooks → { deny, notify, errors, workspaceOpen }
//
// The server executor loads orplex.config.json + installed plugin-bundle rules
// straight from disk for every run. The chat lane executes tools in the
// renderer, which has no filesystem, so it asks here (cached for 60s) and
// evaluates the returned patterns locally before each tool call. Without this
// route the Plugins page's "Hook rules active" toggle guarded only background
// runs — the main coding agent was never gated at all.

import { NextRequest, NextResponse } from "next/server";
import { sessionUserId } from "@/lib/server-session";
import { resolveWorkspaceCwd } from "@/lib/workspace-cwd";
import { loadToolHooks } from "@/lib/tool-hooks";
// Import for its side effect: registers the marketplace bundle provider so the
// gate merges installed library rules (the SDK ships no bundles of its own).
import "@/lib/marketplace-bundles";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const userId = await sessionUserId(request);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const cwd = await resolveWorkspaceCwd(userId);
    if (!cwd) {
      return NextResponse.json({ success: true, workspaceOpen: false, deny: [], notify: [], errors: [] });
    }

    const hooks = await loadToolHooks(cwd);
    return NextResponse.json({
      success: true,
      workspaceOpen: true,
      // Rule SOURCES: the client compiles them, so behaviour is identical to
      // the executor's parseToolHookConfig path.
      deny: hooks.deny.map((r) => r.source),
      notify: hooks.notify.map((r) => r.source),
      errors: hooks.errors,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "failed to load tool hooks" },
      { status: 500 },
    );
  }
}
