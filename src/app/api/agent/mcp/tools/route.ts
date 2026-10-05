// GET /api/agent/mcp/tools — the SDK-lane tool roster for the renderer
// agent loop: the Phase 5 snapshot (names, descriptions, schemas,
// ToolAnnotations) plus each connected server's autoApproveReadOnly toggle
// so the worker's C6 risk gate can classify without localStorage. Read-only;
// tokens never leave the server.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { listSnapshotToolsByServer, loadMcpServerPrefsDb } from "@/lib/mcp/tool-snapshot";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const userId = session.user.id;
    const tools = await listSnapshotToolsByServer(userId);
    const servers = [...new Set(tools.map((t) => t.server))];
    const entries = await Promise.all(
      servers.map(async (server) => [server, await loadMcpServerPrefsDb(userId, server)] as const)
    );
    const serverPrefs = Object.fromEntries(
      entries.map(([server, prefs]) => [server, { autoApproveReadOnly: prefs.autoApproveReadOnly }])
    );
    return NextResponse.json({ success: true, tools, serverPrefs });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
