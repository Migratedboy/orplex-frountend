// Read/click-through-file card: staged in-memory file content.
//
// Local-only route (memory-file-store.ts comment for the rationale). GET
// with ?download=1 answers as an attachment (Content-Disposition); the card
// builds the download from the plain JSON response otherwise. Either path
// dies 410 when the entry is gone — the card renders the honest state
// ("Expired"/"Removed") instead of an error.
import { NextRequest, NextResponse } from "next/server";
import { sessionUserId } from "@/lib/server-session";
import { readMemoryFile } from "@/lib/memory-file-store";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await sessionUserId(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Next 15 delivers route params as a promise.
    const { id: raw } = await params;
    // Store ids are randomUUID; dev demo seeds use prefixed slugs. Neither
    // shape is user-authored, so a URL-safe wide check is enough — no dots or
    // slashes can slip through (these ids only ever index the in-memory map).
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(raw || "")) {
      return NextResponse.json({ error: "Invalid file id" }, { status: 400 });
    }

    const read = readMemoryFile(raw);
    if (!read.meta || read.content === null) {
      // Gone (expired / evicted / restart-wiped): not an error from the
      // client's perspective — a state the card knows how to render.
      return NextResponse.json(
        {
          state: read.tombstone?.reason === "expired" ? "expired" : "removed",
          filename: read.tombstone?.filename ?? null,
        },
        { status: 410 },
      );
    }

    const wantsDownload =
      request.nextUrl.searchParams.get("download") === "1";

    if (wantsDownload) {
      // Content-Disposition uses the staged filename — it already passed
      // validation that keeps it free of control characters and separators.
      return new NextResponse(read.content, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="${read.meta.filename}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    return NextResponse.json({
      state: "live",
      ...read.meta,
      content: read.content,
    });
  } catch {
    return NextResponse.json({ error: "Failed to read staged file" }, { status: 500 });
  }
}
