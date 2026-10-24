// Create a staged in-memory file for the agent's create_file tool.
//
// Local-only route (see src/proxy.ts LOCAL_ONLY_API_PREFIXES): the bytes live
// in the desktop app's own local Next process (see memory-file-store.ts) —
// never on disk, never in Postgres, and NEVER on the serverless backend whose
// module state dies with the request. A memory store that lived there would
// silently forget every file between the create and the download.
//
// Auth mirrors workspace-cwd: sessionUserId (JWT, either cookie name) —
// same-origin session only. Nothing it can be reached with.
import { NextRequest, NextResponse } from "next/server";
import { sessionUserId } from "@/lib/server-session";
import {
  MAX_MEMORY_FILE_BYTES,
  createMemoryFile,
} from "@/lib/memory-file-store";

export const dynamic = "force-dynamic";

const ERROR_STATUS: Record<string, number> = {
  invalid_filename: 400,
  invalid_content: 400,
  too_large: 413,
  internal: 500,
};

// Pre-parse size guard (rejects before the body is fully materialised).
const MAX_BODY_BYTES = Math.ceil(MAX_MEMORY_FILE_BYTES * 1.35);

export async function POST(request: NextRequest) {
  try {
    const userId = await sessionUserId(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const declaredLength = Number(request.headers?.get?.("content-length") || "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: "File exceeds 2MB" },
        { status: 413 },
      );
    }

    let body: { filename?: unknown; content?: unknown; conversationId?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const conversationId =
      typeof body.conversationId === "string" && body.conversationId.length <= 200
        ? body.conversationId
        : null;

    const result = createMemoryFile({
      filename: body.filename,
      content: body.content,
      ownerId: userId,
      conversationId,
    });

    if (!result.ok) {
      // Honest, literal error text: the model reads this verbatim.
      const message =
        result.error === "invalid_filename"
          ? "error: invalid filename — a plain base name with a short extension (e.g. notes.md), no folders, no separators"
          : result.error === "invalid_content"
            ? "error: content must be a non-empty string"
            : result.error === "too_large"
              ? "error: file exceeds 2MB"
              : "error: internal store failure";
      return NextResponse.json(
        { error: message, code: result.error },
        { status: ERROR_STATUS[result.error] ?? 500 },
      );
    }

    return NextResponse.json({
      id: result.file.id,
      filename: result.file.filename,
      bytes: result.file.bytes,
      lines: result.file.lines,
      createdAt: result.file.createdAt,
      expiresAt: result.file.expiresAt,
      evicted: result.evicted,
      duplicate: result.duplicate,
    });
  } catch {
    return NextResponse.json({ error: "Failed to stage file" }, { status: 500 });
  }
}
