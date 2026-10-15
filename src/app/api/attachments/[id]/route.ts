// Serve a locally-stored attachment. Local-only route (see src/proxy.ts), so
// the bytes come from the user's own disk and survive redeploys/offline.
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { getWorkspaceCwdForUser } from "@/lib/workspace-cwd";
import {
  isValidAttachmentId,
  mimeForPath,
  readAttachment,
} from "@/lib/attachment-store";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const workspace = getWorkspaceCwdForUser(session.user.id);
    if (!workspace) {
      return NextResponse.json({ error: "No workspace open" }, { status: 404 });
    }

    // Next 15 delivers route params as a promise.
    const { id: raw } = await params;
    // Accepts "<id>" or "<id><ext>"; the id itself is digest-shaped hex, so a
    // path-traversal attempt fails this check before touching the filesystem.
    const match = /^([a-f0-9]{32})(\.[a-z0-9]{2,5})?$/.exec(raw || "");
    if (!match || !isValidAttachmentId(match[1])) {
      return NextResponse.json({ error: "Invalid attachment id" }, { status: 400 });
    }

    const ext = match[2] ?? "";
    // Without an extension we cannot probe every allowed type cheaply, and
    // guessing wrong would serve bytes under a misleading Content-Type.
    if (!ext) {
      return NextResponse.json(
        { error: "Extension is required" },
        { status: 400 },
      );
    }

    const data = await readAttachment(workspace, match[1], ext);
    if (!data) {
      return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
    }

    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": mimeForPath(ext),
        // Content-addressed: the bytes for a given id never change, so they
        // are safe to cache hard.
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "Failed to read attachment" }, { status: 500 });
  }
}
