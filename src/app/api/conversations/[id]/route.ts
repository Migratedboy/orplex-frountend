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

    // NOTE: update({ where: { id, userId } }) is invalid Prisma — where must
    // be unique and (id, userId) has no unique constraint. Gate ownership
    // first (same as DELETE below), then update by id.
    const owned = await prisma.conversation.findFirst({
      where: { id, userId: session.user.id },
      select: { id: true },
    });
    if (!owned) throw new NotFoundError("Conversation not found");

    const conversation = await prisma.conversation.update({
      where: { id },
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

    // Atomic ownership-scoped delete (no check-then-act race; missing or
    // foreign both 404 without revealing which).
    const deleted = await prisma.conversation.deleteMany({ where: { id, userId: session.user.id } });
    if (deleted.count === 0) throw new NotFoundError("Conversation not found");

    logRequest("DELETE", `/api/conversations/${id}`, start, 200);
    return successResponse({ deleted: true });
  } catch (error) {
    logError(error, { route: "conversations/[id]", method: "DELETE" });
    return handleError(error);
  }
}
