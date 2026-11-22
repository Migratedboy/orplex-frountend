// POST /api/projects/create { name, parent? } — make an empty project folder.
//
// "From scratch" used to mean "open some folder you already own", because the
// app had no way to make one. This is that way: it creates exactly one
// directory (never recursive into an existing tree), refuses to reuse a folder
// that already exists, and answers with the absolute path the caller then
// registers as its workspace.
//
// GET → { defaultParent } so the UI can name the default location instead of
// pretending a folder was chosen.

import { NextRequest, NextResponse } from "next/server";
import { sessionUserId } from "@/lib/server-session";
import { createProjectDir, defaultProjectsDir } from "@/lib/project-paths";
import { publicErrorMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ success: true, defaultParent: defaultProjectsDir() });
}

export async function POST(request: NextRequest) {
  const userId = await sessionUserId(request);
  if (!userId) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const result = await createProjectDir(String(body?.name ?? ""), body?.parent);
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json({ success: true, path: result.path, name: result.name });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, "Could not create the project folder") },
      { status: 500 }
    );
  }
}
