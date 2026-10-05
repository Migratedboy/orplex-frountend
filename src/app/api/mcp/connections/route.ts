// GET /api/mcp/connections — the SDK-lane connectors for the Connectors
// panel: status, tool counts, failure reasons, and the auto-approve toggle.
// The view model (connection-view.ts) is SafeConnection-based — tokens never
// leave store.ts.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { listConnectionViews } from "@/lib/mcp/connection-view";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(jwtOnlyOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const connections = await listConnectionViews(session.user.id);
    return NextResponse.json({ success: true, connections });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
