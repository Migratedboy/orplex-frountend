import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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

    return NextResponse.json({ conversations });
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
