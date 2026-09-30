// Free tier usage — returns current usage and remaining quota

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { hasQuota, getUsage, FREE_TIER } from "@/lib/free-tier/quota-manager";

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const usage = await getUsage(session.user.id);
    const quota = await hasQuota(session.user.id, "free");

    return Response.json({
      tier: "free",
      usage: {
        requestsToday: usage.requestsToday,
        date: usage.date,
      },
      quota: {
        limit: FREE_TIER.DAILY_LIMIT,
        remaining: quota.remaining,
        allowed: quota.allowed,
      },
      limits: {
        maxTokensPerPrompt: FREE_TIER.MAX_TOKENS_PER_PROMPT,
        allowedModels: FREE_TIER.ALLOWED_MODELS,
        maxFileUploads: FREE_TIER.MAX_FILE_UPLOADS,
        maxMessages: FREE_TIER.MAX_MESSAGES_PER_CONVERSATION,
      },
    });
  } catch (error) {
    return Response.json(
      { error: (error as Error).message || "Failed to get usage" },
      { status: 500 }
    );
  }
}
