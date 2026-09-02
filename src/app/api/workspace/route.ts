// List workspaces for the authenticated user

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getUserWorkspaces } from "@/lib/workspace/workspace-manager";

export async function GET(_request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const workspaces = await getUserWorkspaces(session.user.id);
    return Response.json({ workspaces });
  } catch (error) {
    return Response.json(
      { error: (error as Error).message || "Failed to list workspaces" },
      { status: 500 },
    );
  }
}
