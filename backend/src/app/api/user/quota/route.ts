import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ remaining: 50, limit: 50 });
    }

    const quota = await prisma.userQuota.findUnique({
      where: { userId: session.user.id },
    });

    if (!quota) {
      return NextResponse.json({ remaining: 50, limit: 50 });
    }

    // Reset if new day
    const now = new Date();
    const isNewDay = now.toDateString() !== quota.lastResetAt.toDateString();
    const used = isNewDay ? 0 : quota.requestsToday;

    return NextResponse.json({
      remaining: Math.max(0, quota.dailyLimit - used),
      limit: quota.dailyLimit,
    });
  } catch {
    return NextResponse.json({ remaining: 50, limit: 50 });
  }
}
