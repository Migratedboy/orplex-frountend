import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * Strip internal display markers from message content for list previews:
 * [THINKING]…[/THINKING] reasoning blocks, [OK]/[FAIL]/[BLOCKED]/[SUCCESS]
 * status lines, and leftover tool tags. Falls back to the first non-empty
 * line when stripping empties everything (e.g. thinking-only messages).
 */
function cleanSnippet(content: string | null | undefined): string {
  if (!content) return "";
  let text = content
    .replace(/\[THINKING\][\s\S]*?(\[\/THINKING\]|$)/gi, " ")
    .replace(/^\[(?:OK|FAIL|BLOCKED|SUCCESS|ERROR)\][^\n]*$/gim, " ")
    .replace(/<\/?tool_(?:call|result)[^>]*>[\s\S]*?(?:<\/tool_(?:call|result)>|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    text = content.replace(/\[(?:THINKING|\/THINKING)\]/gi, "").replace(/\s+/g, " ").trim();
  }
  return text;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ conversations: [], conversation: null });

    const id = request.nextUrl.searchParams.get("id");

    if (id) {
      // Single conversation: one query
      const conversation = await prisma.conversation.findFirst({
        where: { id, userId: session.user.id },
        include: { messages: { orderBy: { createdAt: "asc" } } },
      });
      return NextResponse.json({ conversation });
    }

    // Single efficient query: list conversations with only the latest message snippet.
    // Previously this also fetched the full latest conversation (all messages), which
    // was unused by the UI and caused unnecessary DB load on every page navigation.
    const conversations = await prisma.conversation.findMany({
      where: { userId: session.user.id },
      include: { messages: { take: 1, orderBy: { createdAt: "desc" } } },
      orderBy: { updatedAt: "desc" },
    });

    // Clean the preview snippet so raw [THINKING]/status markers never leak
    // into the history page or sidebar lists.
    const cleaned = conversations.map((c) => ({
      ...c,
      messages: c.messages?.map((m) => ({ ...m, content: cleanSnippet(m.content) })) ?? [],
    }));

    return NextResponse.json({ conversations: cleaned });
  } catch (error) {
    console.error("[Conversations GET] Error:", error);
    return NextResponse.json({ conversations: [], conversation: null });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { conversationId, messages } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "Messages required" }, { status: 400 });
    }

    // Guard against FK violations from stale JWTs: a session token minted
    // before a DB reset can carry a userId that no longer exists. Upsert the
    // user first so Conversation.userId always has a matching row.
    try {
      await prisma.user.upsert({
        where: { id: session.user.id },
        update: {},
        create: {
          id: session.user.id,
          email: session.user.email || `${session.user.id}@orplex.local`,
          name: session.user.name || "User",
        },
      });
    } catch {
      // If the upsert fails (e.g. email conflict), the create below will
      // surface the real error.
    }

    let conv;
    if (conversationId) {
      conv = await prisma.conversation.update({
        where: { id: conversationId, userId: session.user.id },
        data: {
          messages: { create: messages.map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })) },
          updatedAt: new Date(),
        },
      });
    } else {
      const firstUserMsg = messages.find((m: { role: string }) => m.role === "user");
      const title = firstUserMsg?.content?.slice(0, 60) || "New Chat";
      conv = await prisma.conversation.create({
        data: {
          title,
          userId: session.user.id,
          messages: { create: messages.map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })) },
        },
      });
    }

    return NextResponse.json({ conversationId: conv.id, success: true });
  } catch (error) {
    console.error("[Conversations POST] Error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
