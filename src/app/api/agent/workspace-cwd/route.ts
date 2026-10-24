import { NextRequest, NextResponse } from "next/server";
import { sessionUserId } from "@/lib/server-session";
import { setWorkspaceCwd, getWorkspaceCwdForUser } from "@/lib/workspace-cwd";
import { publicErrorMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** POST { path } — register the caller's opened workspace folder (absolute path). */
export async function POST(request: NextRequest) {
  try {
    const userId = await sessionUserId(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { path } = await request.json();
    const ok = await setWorkspaceCwd(String(path || ""), userId);
    if (!ok) {
      return NextResponse.json({ error: "Invalid directory" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, cwd: getWorkspaceCwdForUser(userId) });
  } catch (error) {
    return NextResponse.json({ error: publicErrorMessage(error, "Internal server error") }, { status: 500 });
  }
}

/** GET — the caller's registered workspace (for display/debug). */
export async function GET(request: NextRequest) {
  const userId = await sessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ cwd: getWorkspaceCwdForUser(userId) });
}
