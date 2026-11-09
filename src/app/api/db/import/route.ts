// POST /api/db/import — restore a portable bundle produced by
// GET /api/db/export. Body: the bundle JSON (raw). Checksums are validated
// per-model inside importSnapshot; anything forged is skipped with reasons.
import { NextResponse } from "next/server";
import { writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { requireAuth } from "@/lib/chat-middleware";

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;
  try {
    const body = await request.text();
    if (!body || !body.trim()) {
      return NextResponse.json({ error: "empty body" }, { status: 400 });
    }
    if (body.length > 50 * 1024 * 1024) {
      return NextResponse.json({ error: "bundle too large (50 MB cap)" }, { status: 413 });
    }
    const { importSnapshot } = await import("@/lib/local-db");
    const tmp = join(tmpdir(), `orplex-import-${Date.now()}.json`);
    await writeFile(tmp, body, "utf8");
    try {
      const result = importSnapshot(tmp);
      const total = Object.values(result.restored).reduce((a, b) => a + b, 0);
      return NextResponse.json({ ok: true, restored: result.restored, skipped: result.skipped, total });
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 400 });
  }
}
