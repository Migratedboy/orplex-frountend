// Update a workspace member's role (admin/owner only)

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { updateMemberRole, hasRole } from "@/lib/workspace/workspace-manager";
import type { WorkspaceRole } from "@/lib/workspace/workspace-manager";

export async function PUT(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { workspaceId, userId, role } = await request.json();
    if (!workspaceId || !userId || !role) {
      return Response.json(
        { error: "workspaceId, userId, and role are required" },
        { status: 400 },
      );
    }

    const validRoles: WorkspaceRole[] = ["owner", "admin", "member"];
    if (!validRoles.includes(role)) {
      return Response.json(
        { error: `role must be one of: ${validRoles.join(", ")}` },
        { status: 400 },
      );
    }

    // Check if caller is admin or owner
    const canUpdate = await hasRole(workspaceId, session.user.id, "admin");
    if (!canUpdate) {
      return Response.json(
        { error: "Only admins and owners can update member roles" },
        { status: 403 },
      );
    }

    const member = await updateMemberRole(workspaceId, userId, role);
    return Response.json({ member });
  } catch (error) {
    return Response.json(
      { error: (error as Error).message || "Failed to update member role" },
      { status: 500 },
    );
  }
}
