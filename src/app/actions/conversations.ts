"use server";

import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function getConversations() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return { conversations: [], conversation: null };

  const conversations = await prisma.conversation.findMany({
    where: { userId: session.user.id },
    include: { messages: { take: 1, orderBy: { createdAt: "desc" } } },
    orderBy: { updatedAt: "desc" },
  });

  return { conversations };
}

export async function getConversation(id: string) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return { conversation: null };

  const conversation = await prisma.conversation.findFirst({
    where: { id, userId: session.user.id },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });

  return { conversation };
}

export async function renameConversation(id: string, title: string) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) throw new Error("Unauthorized");

  await prisma.conversation.update({
    where: { id, userId: session.user.id },
    data: { title: title.trim() },
  });

  return { success: true };
}

export async function deleteConversation(id: string) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) throw new Error("Unauthorized");

  await prisma.conversation.delete({ where: { id } });

  return { success: true };
}
