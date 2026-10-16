import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/chat-middleware";
import {
  insightsSummary,
  learnPatternsFromTrajectories,
  topPatterns,
  recallSimilar,
} from "@/lib/agent-insights";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent/insights — read side of the agent insight store.
 *
 *   ?summary=1        counts across tasks, trajectories, patterns, memory
 *   ?learn=1          re-mine trajectories into tool-sequence patterns (writes)
 *   ?patterns=1       the best-performing learned patterns
 *   ?recall=<text>    semantic recall of similar past work
 *
 * Auth: same session gate as the other agent routes.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const params = request.nextUrl.searchParams;

  try {
    if (params.get("summary")) {
      return NextResponse.json({ success: true, summary: await insightsSummary(auth.userId) });
    }

    if (params.get("learn")) {
      const learned = await learnPatternsFromTrajectories();
      return NextResponse.json({ success: true, learned: learned.length, patterns: learned });
    }

    if (params.get("patterns")) {
      return NextResponse.json({ success: true, patterns: await topPatterns() });
    }

    const recall = params.get("recall");
    if (recall) {
      return NextResponse.json({ success: true, query: recall, hits: await recallSimilar(recall) });
    }

    return NextResponse.json(
      { success: false, error: "Pass one of: summary, learn, patterns, recall." },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Insights query failed." },
      { status: 500 }
    );
  }
}