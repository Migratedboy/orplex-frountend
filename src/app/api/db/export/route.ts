// GET /api/db/export — download the whole local database as one portable
// JSON bundle (exportSnapshot in local-db.ts). Read-only; safe to call anytime.
import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { requireAuth } from "@/lib/chat-middleware";

export async function GET() {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;
  try {
    const { exportSnapshot } = await import("@/lib/local-db");
    const filePath = exportSnapshot();
    const body = await readFile(filePath, "utf8");
    const name = filePath.split(/[\\/]/).pop() || "orplex-db-export.json";
    return new NextResponse(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${name}"`,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
