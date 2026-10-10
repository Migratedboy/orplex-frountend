import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { listPlaybooks, searchPlaybooks, mergeOrCreate } from "@/lib/playbook";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Per-user scope: learnings are private to the authenticated user.
    // (The executor passes run.userId for server runs; browser lanes land
    // here scoped by session.)
    const projectId = session.user.id;
    const search = request.nextUrl.searchParams.get("q");

    if (search) {
      const results = await searchPlaybooks(projectId, search, 10);
      return NextResponse.json({ results });
    }

    const entries = await listPlaybooks(projectId);
    return NextResponse.json({ entries });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/playbook — skill_create write path for the agent tool.
 * The agent supplies a title + self-contained procedure; the server stores
 * it as a verified skill entry (user-authored skills skip the run gate).
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const title = typeof body?.title === "string" ? body.title.trim().slice(0, 100) : "";
    const text = typeof body?.text === "string" ? body.text.trim().slice(0, 2000) : "";
    if (!title || !text) {
      return NextResponse.json({ error: "title and text are required" }, { status: 400 });
    }

    const entry = await mergeOrCreate(session.user.id, {
      pattern: "skill",
      content: `${title}: ${text}`,
      tags: ["skill", title.toLowerCase().slice(0, 40)],
      evidence: { source: "skill_create" },
    });
    return NextResponse.json({ entry });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}
