import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { UnauthorizedError, NotFoundError, ValidationError, handleError, successResponse } from "@/lib/errors";
import { logRequest, logError } from "@/lib/logger";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const start = Date.now();
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) throw new UnauthorizedError();

    const conversation = await prisma.conversation.findFirst({
      where: { id, userId: session.user.id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!conversation) throw new NotFoundError("Conversation not found");

    logRequest("GET", `/api/conversations/${id}`, start, 200);
    return successResponse(conversation);
  } catch (error) {
    logError(error, { route: "conversations/[id]", method: "GET" });
    return handleError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const start = Date.now();
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) throw new UnauthorizedError();

    const body = await request.json();

    // Validate input
    if (!body.title || typeof body.title !== "string") {
      throw new ValidationError("Title is required", [{ field: "title", message: "Must be a non-empty string" }]);
    }
    if (body.title.length > 200) {
      throw new ValidationError("Title too long", [{ field: "title", message: "Must be under 200 characters" }]);
    }

    const conversation = await prisma.conversation.update({
      where: { id, userId: session.user.id },
      data: { title: body.title.trim() },
    });

    logRequest("PATCH", `/api/conversations/${id}`, start, 200);
    return successResponse(conversation);
  } catch (error) {
    logError(error, { route: "conversations/[id]", method: "PATCH" });
    return handleError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const start = Date.now();
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) throw new UnauthorizedError();

    // Check if conversation exists before deleting
    const conversation = await prisma.conversation.findFirst({
      where: { id, userId: session.user.id },
    });
    if (!conversation) throw new NotFoundError("Conversation not found");

    await prisma.conversation.delete({ where: { id } });

    logRequest("DELETE", `/api/conversations/${id}`, start, 200);
    return successResponse({ deleted: true });
  } catch (error) {
    logError(error, { route: "conversations/[id]", method: "DELETE" });
    return handleError(error);
  }
}
