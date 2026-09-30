// Free tier signup — creates a UserQuota record with free tier defaults

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { FREE_TIER } from "@/lib/free-tier/quota-manager";

export async function POST(_request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return Response.json(
        { error: "Must be signed in to create free tier account" },
        { status: 401 },
      );
    }

    const userId = session.user.id;

    // Check user exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true },
    });

    if (!user) {
      return Response.json({ error: "User not found" }, { status: 404 });
    }

    // Check if user already has a quota record
    const existingQuota = await prisma.userQuota.findUnique({
      where: { userId },
    });

    if (existingQuota) {
      // Already signed up — return existing tier info
      return Response.json({
        user,
        tier: existingQuota.tier,
        isNew: false,
        quota: {
          requestsToday: existingQuota.requestsToday,
          dailyLimit: existingQuota.dailyLimit,
          lastResetAt: existingQuota.lastResetAt,
        },
        limits: {
          dailyPrompts: FREE_TIER.DAILY_LIMIT,
          allowedModels: [...FREE_TIER.ALLOWED_MODELS],
          maxTokensPerPrompt: FREE_TIER.MAX_TOKENS_PER_PROMPT,
          maxFileUploads: FREE_TIER.MAX_FILE_UPLOADS,
          maxMessages: FREE_TIER.MAX_MESSAGES_PER_CONVERSATION,
        },
      });
    }

    // Create new free-tier quota record
    const quota = await prisma.userQuota.create({
      data: {
        userId,
        requestsToday: 0,
        dailyLimit: FREE_TIER.DAILY_LIMIT,
        tier: "free",
      },
    });

    return Response.json({
      user,
      tier: "free",
      isNew: true,
      quota: {
        requestsToday: quota.requestsToday,
        dailyLimit: quota.dailyLimit,
        lastResetAt: quota.lastResetAt,
      },
      limits: {
        dailyPrompts: FREE_TIER.DAILY_LIMIT,
        allowedModels: [...FREE_TIER.ALLOWED_MODELS],
        maxTokensPerPrompt: FREE_TIER.MAX_TOKENS_PER_PROMPT,
        maxFileUploads: FREE_TIER.MAX_FILE_UPLOADS,
        maxMessages: FREE_TIER.MAX_MESSAGES_PER_CONVERSATION,
      },
    });
  } catch (error) {
    return Response.json(
      { error: (error as Error).message || "Signup failed" },
      { status: 500 },
    );
  }
}
