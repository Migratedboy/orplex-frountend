import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { join } from "path";
import { readFile } from "fs/promises";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const baseDir = process.env.ORPLEX_REPOS_DIR || join(process.cwd(), ".orplex-repos");
  try {
    const raw = await readFile(join(baseDir, "repos.json"), "utf-8");
    const all = JSON.parse(raw) as Array<Record<string, unknown>>;
    const mine = all.filter((r) => r.userId === session.user.id);
    return NextResponse.json({ success: true, repos: mine });
  } catch {
    return NextResponse.json({ success: true, repos: [] });
  }
}