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
  // Single conversation: one query (message list capped to avoid OOM on huge
  // threads).
  //
  // The cap used to be `orderBy: {createdAt:"asc"}, take: 500`, which Prisma
  // applies AFTER ordering - so it returned the OLDEST 500 rows. Past 250
  // turns the user's actual recent history was unreachable: the transcript just
  // appeared to end mid-conversation, while the sidebar snippet showed newer
  // messages. Every new turn kept appending to a thread the UI could not show.
  //
  // Take the NEWEST 500 (descending), then reverse back to ascending for the
  // client. `createdAt` alone is not a stable sort: it is
  // TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP, and both messages of a turn are
  // inserted in one nested-create transaction, so every user/assistant pair
  // shares an identical timestamp. `id` breaks the tie deterministically.
  const conversation = await prisma.conversation.findFirst({
    where: { id, userId: session.user.id },
    include: {
      messages: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 500,
      },
    },
  });
  if (conversation) {
    conversation.messages.reverse();
  }
  return NextResponse.json({ conversation });
    }

    // Single efficient query: list conversations with only the latest message snippet.
    // Previously this also fetched the full latest conversation (all messages), which
    // was unused by the UI and caused unnecessary DB load on every page navigation.
    // Capped + cursor-paginated to avoid OOM on accounts with many threads.
    const limitRaw = request.nextUrl.searchParams.get("limit");
    const limit = Math.min(Math.max(Number(limitRaw) || 50, 1), 100);
    const cursor = request.nextUrl.searchParams.get("cursor");
    const conversations = await prisma.conversation.findMany({
      where: { userId: session.user.id },
      include: { messages: { take: 1, orderBy: { createdAt: "desc" } } },
      orderBy: { updatedAt: "desc" },
      take: limit,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
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

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    const conversationId = typeof (body as { conversationId?: unknown }).conversationId === "string"
      ? (body as { conversationId?: string }).conversationId as string
      : undefined;
    const rawMessages = Array.isArray((body as { messages?: unknown }).messages)
      ? (body as { messages?: unknown }).messages as Array<{ role?: unknown; content?: unknown }>
      : [];

    // Workspace folder the thread belongs to (open folder's NAME). Sanitized:
    // null/undefined/empty → null (Ungrouped), capped length, trimmed.
    const rawWorkspace = typeof (body as { workspaceName?: unknown }).workspaceName === "string"
      ? ((body as { workspaceName?: string }).workspaceName as string).trim()
      : "";
    const workspaceName = rawWorkspace ? rawWorkspace.slice(0, 120) : null;

    if (rawMessages.length === 0) {
      return NextResponse.json({ error: "Messages required" }, { status: 400 });
    }
    if (rawMessages.length > 200) {
      return NextResponse.json({ error: "Too many messages (max 200)" }, { status: 400 });
    }
  // Role allowlist + per-message caps: raw roles/content flow straight
  // into Message rows — unbounded input is DB bloat.
  //
  // The 50k cap silently amputated any long answer mid-sentence with no
  // marker, so a bubble that looked complete in-session ended abruptly at
  // 50k after a reload, and the client was never told its content had been
  // shortened. Mark it in the stored content (so the truncation is visible
  // where the data is read) and report it in the response (so the client can
  // surface it).
  const MAX_MESSAGE_CHARS = 50_000;
  const TRUNCATION_MARKER = "\n\n[... truncated at 50000 characters — the full text was not persisted]";
  let truncatedCount = 0;
  const messages = rawMessages.map((m) => {
    const raw = typeof m.content === "string" ? m.content : "";
    const wasTruncated = raw.length > MAX_MESSAGE_CHARS;
    if (wasTruncated) truncatedCount++;
    return {
      role: m.role === "user" || m.role === "assistant" || m.role === "system" ? m.role : "user",
      content: wasTruncated ? raw.slice(0, MAX_MESSAGE_CHARS) + TRUNCATION_MARKER : raw,
    };
  });

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
      // NOTE: where must be unique — (id, userId) is not. Gate ownership
      // first, then update by id (same pattern as PATCH /conversations/[id]).
      const owned = await prisma.conversation.findFirst({
        where: { id: conversationId, userId: session.user.id },
        select: { id: true },
      });
      if (!owned) {
        return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
      }
      conv = await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          messages: { create: messages.map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })) },
          // Keep the workspace tag fresh when provided (a thread opened with
          // no folder later would send null — don't wipe an existing tag then).
          ...(body.workspaceName !== undefined ? { workspaceName } : {}),
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
          workspaceName,
          messages: { create: messages.map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })) },
        },
      });
    }

    return NextResponse.json({
      conversationId: conv.id,
      success: true,
      // Tell the caller when its content was shortened, so it can warn rather
      // than let the user believe a long answer was stored in full.
      ...(truncatedCount > 0 ? { truncatedMessages: truncatedCount } : {}),
    });
  } catch (error) {
    console.error("[Conversations POST] Error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
