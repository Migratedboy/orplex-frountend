import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { setWorkspaceCwd, getWorkspaceCwdForUser } from "@/lib/workspace-cwd";

export const dynamic = "force-dynamic";

/** POST { path } — register the caller's opened workspace folder (absolute path). */
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    const userId = session?.user?.id;
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
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

/** GET — the caller's registered workspace (for display/debug). */
export async function GET() {
  const session = await getServerSession(jwtOnlyOptions);
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ cwd: getWorkspaceCwdForUser(userId) });
}
