// Serve read-only files from the user's registered workspace (verification
// screenshots, recordings, timeline steps) so artifact cards can render real
// content. Path containment is enforced: only files INSIDE the workspace root
// are reachable, no matter how the client forms the path.
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { getWorkspaceCwdForUser } from "@/lib/workspace-cwd";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep, extname } from "node:path";

export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

const MAX_BYTES = 20 * 1024 * 1024;

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const workspace = getWorkspaceCwdForUser(session.user.id);
    if (!workspace) {
      return NextResponse.json({ error: "No workspace open" }, { status: 404 });
    }

    const rel = request.nextUrl.searchParams.get("path") || "";
    if (!rel) {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }

    // Containment check: resolve the requested path against the workspace
    // root and require the result to stay inside it. An absolute `path` (as
    // stored in artifact content) resolves to itself and still passes only
    // when it lives under the workspace.
    const root = resolve(workspace);
    const full = resolve(root, rel);
    if (full !== root && !full.startsWith(root + sep)) {
      return NextResponse.json({ error: "Path escapes workspace" }, { status: 403 });
    }

    const st = await stat(full).catch(() => null);
    if (!st || !st.isFile()) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    if (st.size > MAX_BYTES) {
      return NextResponse.json({ error: "File too large" }, { status: 413 });
    }

    const data = await readFile(full);
    const mime = MIME[extname(full).toLowerCase()] || "application/octet-stream";
    // Same stored-XSS sink as /api/attachments: an SVG (or any scriptable
    // document) rendered as a top-level document executes its <script>, and in
    // the Electron shell that reaches the terminal bridge, which spawns with
    // shell:true. This route is reachable for ANY .svg in the user's workspace,
    // including ones written by an agent or pulled from a repo, so it is the
    // easier of the two to reach. Raster types are exempt so screenshots and
    // recordings keep rendering in <img>/<video>.
    const scriptable = /\.(svg|html?|xhtml|xml|xsl|xslt)$/i.test(full);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": mime,
        // Artifacts are immutable once captured; short private cache for UX
        "Cache-Control": "private, max-age=60",
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
    return NextResponse.json({ error: "Failed to read file" }, { status: 500 });
  }
}
