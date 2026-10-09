// Delete a workspace (owner only)

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { deleteWorkspace } from "@/lib/workspace/workspace-manager";
import { publicErrorMessage } from "@/lib/errors";

export async function DELETE(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { workspaceId } = await request.json();
    if (!workspaceId) {
      return Response.json({ error: "workspaceId is required" }, { status: 400 });
    }

    await deleteWorkspace(workspaceId, session.user.id);
    return Response.json({ success: true });
  } catch (error) {
    return Response.json(
      { error: publicErrorMessage(error, "Failed to delete workspace") },
      { status: 500 },
    );
  }
}
