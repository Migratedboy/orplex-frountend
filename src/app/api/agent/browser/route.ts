import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { runBrowserOp } from "@/lib/agent-browser-session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/agent/browser — Server-backed browser_* tools.
 *
 * Body: { op, url?, selector?, text?, key?, dx?, dy?, sessionId? }
 * Same result shapes the Electron agent-browser bridge produces, so the
 * model sees one identical tool contract whether the browser lives in the
 * desktop shell or on the server. Navigation is SSRF-guarded server-side;
 * sessions are per-user with caps and idle reaping (see agent-browser-session).
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body.op !== "string") {
    return NextResponse.json({ ok: false, error: "op required" }, { status: 400 });
  }

  const result = await runBrowserOp(session.user.id, body.op, {
    url: typeof body.url === "string" ? body.url : undefined,
    selector: typeof body.selector === "string" ? body.selector : undefined,
    text: typeof body.text === "string" ? body.text : undefined,
    key: typeof body.key === "string" ? body.key : undefined,
    dx: typeof body.dx === "number" ? body.dx : undefined,
    dy: typeof body.dy === "number" ? body.dy : undefined,
    sessionId: typeof body.sessionId === "string" ? body.sessionId.slice(0, 64) : undefined,
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
