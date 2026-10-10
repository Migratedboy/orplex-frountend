import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const q = request.nextUrl.searchParams.get("q") || "";
    if (!q.trim()) {
      return NextResponse.json({ results: [] });
    }

    const userId = session.user.id;
    const messages = await prisma.message.findMany({
      where: {
        conversation: { userId },
        content: { contains: q, mode: "insensitive" },
      },
      include: {
        conversation: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    // Lexical ranking (exact-phrase hits outrank partial matches). No
    // embedding call here: it only gated this same lexical check while
    // paying model-load latency on a cold server.
    const qLower = q.toLowerCase();
    const scored = messages.map((m) => {
      let score = 1;
      if (m.content.toLowerCase().includes(qLower)) score += 2;
      return {
        id: m.id,
        conversationId: m.conversationId,
        conversationTitle: m.conversation.title,
        content: m.content.slice(0, 300),
        createdAt: m.createdAt,
        score,
      };
    });

    scored.sort((a, b) => b.score - a.score);

    return NextResponse.json({ results: scored.slice(0, 10) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 }
    );
  }
}
