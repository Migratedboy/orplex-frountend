// Invite a user to a workspace

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { addMember, hasRole } from "@/lib/workspace/workspace-manager";
import { publicErrorMessage } from "@/lib/errors";

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { workspaceId, email, role } = await request.json();
    if (!workspaceId || !email) {
      return Response.json(
        { error: "workspaceId and email are required" },
        { status: 400 }
      );
    }

    // Check if inviter has admin or owner role
    const canInvite = await hasRole(workspaceId, session.user.id, "admin");
    if (!canInvite) {
      return Response.json(
        { error: "Only admins and owners can invite members" },
        { status: 403 }
      );
    }

    // Find user by email
    const { prisma } = await import("@/lib/prisma");
    const user = await prisma.user.findFirst({
      where: { email },
      select: { id: true },
    });

    if (!user) {
      return Response.json(
        { error: "No user found with that email" },
        { status: 404 }
      );
    }

    const member = await addMember(workspaceId, user.id, role || "member");
    return Response.json({ member });
  } catch (error) {
    return Response.json(
      { error: publicErrorMessage(error, "Failed to invite member") },
      { status: 500 }
    );
  }
}
