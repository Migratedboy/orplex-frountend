import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const accounts = await prisma.account.findMany({
    where: { userId: session.user.id },
    select: { provider: true },
  });
  return NextResponse.json({ success: true, providers: accounts.map((a) => a.provider) });
}