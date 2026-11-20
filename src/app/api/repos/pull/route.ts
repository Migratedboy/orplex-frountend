import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { execFileSync } from "child_process";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const repoPath = typeof body?.path === "string" ? body.path.trim() : "";
  if (!repoPath) {
    return NextResponse.json({ success: false, error: "path is required" }, { status: 400 });
  }
  // Basic path safety: must be absolute and not contain traversal.
  if (repoPath.includes("..")) {
    return NextResponse.json({ success: false, error: "Invalid path" }, { status: 400 });
  }
  try {
    const out = execFileSync("git", ["-C", repoPath, "pull", "--ff-only"], { stdio: "pipe", timeout: 120_000 }).toString();
    return NextResponse.json({ success: true, output: out.slice(0, 4000) });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString?.() || (err instanceof Error ? err.message : String(err));
    return NextResponse.json({ success: false, error: stderr.slice(0, 2000) }, { status: 500 });
  }
}