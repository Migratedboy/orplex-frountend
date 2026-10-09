// POST /api/mcp/oauth/complete — desktop leg of the OAuth callback.
//
// The Electron loopback listener catches the AS redirect on 127.0.0.1 and
// relays {code, state, iss, error…} to the renderer, which POSTs here WITH its
// session cookie (the main process has no cookies — the renderer does). The
// one-time server-stored state is the correlation + CSRF token: claim it,
// bind it to the session user, exchange through the SDK's finishAuth.

import { NextRequest, NextResponse } from "next/server";
import { getMcpSession } from "@/lib/mcp-auth";
import { completeAuthorization, type CompleteErrorCode } from "@/lib/mcp/oauth/flow";
import { refreshServerSnapshot } from "@/lib/mcp/roster-refresh";

export const dynamic = "force-dynamic";

function statusFor(code: CompleteErrorCode): number {
  if (code === "state_unknown" || code === "state_expired" || code === "state_used" || code === "state_failed" || code === "wrong_owner" || code === "denied") {
    return 400;
  }
  if (code === "exchange_failed" || code === "issuer_mismatch" || code === "verify_failed") return 502;
  return 400; // no_remote
}

export async function POST(request: NextRequest) {
  const session = await getMcpSession();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const state = typeof body.state === "string" ? body.state : "";
  if (!state) {
    return NextResponse.json({ success: false, error: "missing state" }, { status: 400 });
  }

  const params = new URLSearchParams();
  for (const key of ["code", "iss", "error", "error_description", "state"]) {
    const v = body[key];
    if (typeof v === "string" && v.length > 0 && v.length <= 4096) params.set(key, v);
  }

  try {
    const result = await completeAuthorization({ userId: session.user.id, state, params });
    if (result.status === "error") {
      return NextResponse.json({ success: false, ...result }, { status: statusFor(result.code) });
    }
    // Phase 9: kick hub discovery now so the roster (prompts, tool counts,
    // /api/agent/mcp/tools) populates without waiting for the next call.
    void refreshServerSnapshot(session.user.id, result.serverId).catch(() => {});
    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { success: false, status: "error", code: "exchange_failed", error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
