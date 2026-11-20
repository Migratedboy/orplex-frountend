import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function DELETE(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const userId = session.user.id;
  const body = await request.json().catch(() => ({}));
  const confirm = typeof body?.confirm === "string" ? body.confirm.trim() : "";
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user || !user.email || confirm !== user.email) {
    return NextResponse.json({ success: false, error: "Confirmation email does not match" }, { status: 400 });
  }

  try {
    await prisma.$transaction(async (tx) => {
      const runs = await tx.agentRun.findMany({ where: { userId }, select: { id: true } });
      const runIds = runs.map((r) => r.id);
      if (runIds.length) {
        await tx.runEvent.deleteMany({ where: { runId: { in: runIds } } });
        await tx.agentRun.deleteMany({ where: { id: { in: runIds } } });
      }
      await tx.conversation.deleteMany({ where: { userId } });
      await tx.userApiKey.deleteMany({ where: { userId } });
      await tx.account.deleteMany({ where: { userId } });
      await tx.session.deleteMany({ where: { userId } });
      await tx.user.delete({ where: { id: userId } });
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[account] delete failed:", err);
    return NextResponse.json({ success: false, error: "Account deletion failed" }, { status: 500 });
  }
}