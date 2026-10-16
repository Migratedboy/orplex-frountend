// Serve a locally-stored attachment. Local-only route (see src/proxy.ts), so
// the bytes come from the user's own disk and survive redeploys/offline.
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { resolveWorkspaceCwd } from "@/lib/workspace-cwd";
import {
  isValidAttachmentId,
  locateAttachment,
  mimeForPath,
} from "@/lib/attachment-store";

export const dynamic = "force-dynamic";

/** The user's durable workspace path from the DB, used as a fallback root. */
async function recordedWorkspaceFor(userId: string): Promise<string | null> {
  try {
    const { prisma } = await import("@/lib/prisma");
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { workspacePath: true },
    });
    return u?.workspacePath || null;
  } catch {
    return null;
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Async resolver, not the sync in-memory getter: the registration map is
    // per-process, so a restart would 404 an otherwise-open workspace.
    const workspace = await resolveWorkspaceCwd(session.user.id);
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

    // The current workspace is the common case, but the reference stored in the
    // message body is workspace-AGNOSTIC while the bytes live in whichever
    // folder was open at upload time. Falling back to the user's recorded
    // workspace path keeps historical images resolvable after the folder is
    // closed or the user switches projects - previously they all 404'd even
    // though the files were still on disk.
    const roots: string[] = [];
    if (workspace) roots.push(workspace);
    const recorded = await recordedWorkspaceFor(session.user.id);
    if (recorded) roots.push(recorded);

    const found = await locateAttachment(roots, match[1], ext);
    if (!found) {
      return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
    }
    const data = found.data;

    // An SVG served inline executes its <script> when navigated to directly -
    // nosniff does not help, because the declared type really is
    // image/svg+xml - and in the Electron shell that reaches
    // window.orplexDesktop.terminal.exec, which spawns with shell:true. That is
    // arbitrary code execution from an attached file.
    //
    // Raster types are exempt: browsers ignore Content-Disposition for <img>
    // subresource loads, and these are only ever rendered as thumbnails, so
    // restricting the dangerous ones keeps display working without reopening
    // the hole for anything scriptable.
    const scriptable = ext.toLowerCase() === ".svg";
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": mimeForPath(ext),
        // Content-addressed: the bytes for a given id never change, so they
        // are safe to cache hard.
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        ...(scriptable
          ? {
              "Content-Disposition": "attachment",
              "Content-Security-Policy":
                "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
            }
          : {}),
      },
    });
  } catch {
    return NextResponse.json({ error: "Failed to read attachment" }, { status: 500 });
  }
}
