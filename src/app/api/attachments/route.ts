// Persist a chat image to the user's LOCAL disk (workspace .orplex/attachments).
// Never to Postgres — see src/lib/attachment-store.ts for the rationale.
//
// Registered in src/proxy.ts LOCAL_ONLY_API_ROUTES so it is always handled by
// the local Next process instead of being proxied to the cloud backend, whose
// filesystem is ephemeral.
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { resolveWorkspaceCwd } from "@/lib/workspace-cwd";
import {
  MAX_ARCHIVE_ATTACHMENT_BYTES,
  attachmentUrl,
  parseImageDataUrl,
  saveAttachment,
} from "@/lib/attachment-store";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // resolveWorkspaceCwd (not the sync in-memory getter): the registration map
    // is per-process, so after a restart a legitimately open workspace would
    // 404 here. The async resolver falls back to the durable User.workspacePath.
    const workspace = await resolveWorkspaceCwd(session.user.id);
    if (!workspace) {
      return NextResponse.json(
        { error: "No workspace open — open a project first" },
        { status: 404 },
      );
    }

    let body: { dataUrl?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (typeof body.dataUrl !== "string" || !body.dataUrl) {
      return NextResponse.json({ error: "dataUrl is required" }, { status: 400 });
    }

    // A base64 payload inflates ~33%, so reject obviously oversized bodies
    // before decoding. The decoded size is re-checked in parseImageDataUrl
    // against the per-type ceiling (archives get a larger one).
    if (body.dataUrl.length > MAX_ARCHIVE_ATTACHMENT_BYTES * 1.4) {
      return NextResponse.json(
        {
          error: `File exceeds ${Math.floor(MAX_ARCHIVE_ATTACHMENT_BYTES / 1024 / 1024)}MB`,
        },
        { status: 413 },
      );
    }

    const parsed = parseImageDataUrl(body.dataUrl);
    if (!parsed) {
      return NextResponse.json(
        { error: "Unsupported or invalid image" },
        { status: 400 },
      );
    }

    const saved = await saveAttachment(workspace, parsed);
    return NextResponse.json({
      id: saved.id,
      filename: saved.filename,
      bytes: saved.bytes,
      url: attachmentUrl(saved.id, parsed.ext),
    });
  } catch {
    return NextResponse.json({ error: "Failed to store attachment" }, { status: 500 });
  }
}
