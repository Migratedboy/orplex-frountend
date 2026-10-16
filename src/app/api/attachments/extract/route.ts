// Extract an attached archive LOCALLY and return its text contents inline.
//
// Why this exists: the agent tool loop runs on the cloud backend, which is a
// different machine from the user's disk. A .zip stored at
// <workspace>/.orplex/attachments/ is therefore unreachable to the model no
// matter which tools it has — the filesystem simply is not there. So the
// desktop app does the unpacking itself and ships the extracted text along
// with the request, the same way ordinary file attachments already travel.
//
// The .zip itself is never uploaded anywhere; it stays on the user's disk.
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { resolveWorkspaceCwd } from "@/lib/workspace-cwd";
import { extractZip } from "@/lib/agent/archive-extract";
import { attachmentUrl, isValidAttachmentId } from "@/lib/attachment-store";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";

// Cap concurrent extractions. Each holds the whole archive in memory (see
// archive-extract), so N parallel requests multiply the peak.
let inFlight = 0;
const MAX_INFLIGHT = 2;
const MAX_BODY_BYTES = 64 * 1024;

/** Cap on the text we inline, so a 5k-file archive cannot blow the context. */
const MAX_INLINE_BYTES = 120_000;
const MAX_INLINE_FILES = 40;
const MAX_FILE_BYTES = 12_000;

const TEXTY = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|markdown|txt|csv|ya?ml|toml|html|css|scss|py|rb|go|rs|java|c|h|cpp|cs|sql|sh|bash|env|gitignore|vue|svelte|prisma|graphql|php|kt|swift|lua|ini|conf|log)$/i;

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const workspace = await resolveWorkspaceCwd(session.user.id);
    if (!workspace) {
      return NextResponse.json({ error: "No workspace open" }, { status: 404 });
    }

  // Refuse an oversized body BEFORE parsing. Same reason as the upload route:
  // request.json() materialises the whole body as a string, and this route has
  // no body limit, so one huge request OOMs the Next process.
  const declared = Number(request.headers?.get?.("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    id?: unknown;
    ext?: unknown;
    dest?: unknown;
  };
    const id = typeof body.id === "string" ? body.id : "";
    if (!isValidAttachmentId(id)) {
      return NextResponse.json({ error: "Invalid attachment id" }, { status: 400 });
    }
    const ext = typeof body.ext === "string" ? body.ext : ".zip";
    if (ext !== ".zip") {
      return NextResponse.json({ error: "Only .zip is supported" }, { status: 400 });
    }

    const dest = typeof body.dest === "string" && body.dest.trim() ? body.dest.trim() : undefined;
    const archiveRel = `.orplex/attachments/${id}${ext}`;

  if (inFlight >= MAX_INFLIGHT) {
    return NextResponse.json(
      { error: "Another extraction is already running — try again in a moment." },
      { status: 429 },
    );
  }
  inFlight++;
  // (the outer try/catch/finally below covers this block; inFlight is released there)
    const out = await extractZip({
      root: workspace,
      archivePath: archiveRel,
      destRel: dest,
    });
    if (!out.ok) {
      return NextResponse.json({ error: out.summary, code: out.error }, { status: 400 });
    }

    // Inline the readable text files so the model actually sees the contents.
    const files: { path: string; content: string }[] = [];
    let budget = MAX_INLINE_BYTES;
    for (const w of out.written) {
      if (files.length >= MAX_INLINE_FILES) break;
      if (w.bytes > MAX_FILE_BYTES) continue;
      if (!TEXTY.test(w.path) && !w.path.includes("/")) continue;
      try {
        const raw = await readFile(join(workspace, out.dest, w.path), "utf8");
        if (raw.length > budget) continue;
        budget -= raw.length;
        files.push({ path: w.path, content: raw });
      } catch {
        /* unreadable/binary — skip */
      }
    }

    return NextResponse.json({
      dest: out.dest,
      written: out.written.length,
      skipped: out.skipped.length,
      files,
      truncated: out.written.length > files.length,
      url: attachmentUrl(id, ext),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to extract" },
      { status: 500 },
    );
  } finally {
    inFlight = Math.max(0, inFlight - 1);
  }
}
