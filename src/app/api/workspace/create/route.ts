// Create a new workspace

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createWorkspace } from "@/lib/workspace/workspace-manager";
import { publicErrorMessage } from "@/lib/errors";

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { name } = await request.json();
    if (!name || typeof name !== "string" || name.trim().length < 2) {
      return Response.json(
        { error: "Workspace name must be at least 2 characters" },
        { status: 400 }
      );
    }

    const workspace = await createWorkspace(name.trim(), session.user.id);
    return Response.json({ workspace });
  } catch (error) {
    return Response.json(
      { error: publicErrorMessage(error, "Failed to create workspace") },
      { status: 500 }
    );
  }
}
