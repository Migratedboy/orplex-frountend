import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const { provider } = await params;
  const accounts = await prisma.account.findMany({ where: { userId: session.user.id } });
  if (accounts.length <= 1) {
    return NextResponse.json({ success: false, error: "Cannot disconnect your only sign-in method" }, { status: 400 });
  }
  const target = accounts.find((a) => a.provider === provider);
  if (!target) {
    return NextResponse.json({ success: false, error: "Provider not linked" }, { status: 404 });
  }
  await prisma.account.delete({ where: { id: target.id } });
  return NextResponse.json({ success: true });
}