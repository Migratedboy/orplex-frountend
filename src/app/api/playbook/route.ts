import { NextRequest, NextResponse } from "next/server";
import { sessionUserId } from "@/lib/server-session";
import { listPlaybooks, searchPlaybooks, mergeOrCreate } from "@/lib/playbook";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    // sessionUserId (NOT getServerSession(authOptions)): the packaged app
    // ships no NEXTAUTH_SECRET, so importing @/lib/auth kills the whole
    // route chunk at module evaluation (its prod fail-fast throw → empty
    // 500 — the "Playbook list failed" bug). sessionUserId verifies the
    // next-auth JWT when a secret exists and falls back to the Ed25519
    // app-session cookie otherwise, covering both cookie names too.
    const userId = await sessionUserId(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Per-user scope: learnings are private to the authenticated user.
    // (The executor passes run.userId for server runs; browser lanes land
    // here scoped by session.)
    const projectId = userId;
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
    const userId = await sessionUserId(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const title = typeof body?.title === "string" ? body.title.trim().slice(0, 100) : "";
    const text = typeof body?.text === "string" ? body.text.trim().slice(0, 2000) : "";
    if (!title || !text) {
      return NextResponse.json({ error: "title and text are required" }, { status: 400 });
    }

    const entry = await mergeOrCreate(userId, {
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
