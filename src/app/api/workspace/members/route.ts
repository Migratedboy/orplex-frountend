// Get workspace members

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getWorkspaceMembers, hasRole } from "@/lib/workspace/workspace-manager";

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");
    if (!workspaceId) {
      return Response.json({ error: "workspaceId is required" }, { status: 400 });
    }

    // Check if user is a member
    const isMember = await hasRole(workspaceId, session.user.id, "member");
    if (!isMember) {
      return Response.json({ error: "Not a member of this workspace" }, { status: 403 });
    }

    const members = await getWorkspaceMembers(workspaceId);
    return Response.json({ members });
  } catch (error) {
    return Response.json(
      { error: (error as Error).message || "Failed to get members" },
      { status: 500 }
    );
  }
}
