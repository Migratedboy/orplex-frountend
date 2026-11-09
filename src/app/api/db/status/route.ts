// GET /api/db/status — which bundle file is kept on disk, how big it is,
// and the per-model integrity summary (verifyLocalDb + localDbStatus).
import { NextResponse } from "next/server";
import { stat } from "fs/promises";
import { join } from "path";
import { requireAuth } from "@/lib/chat-middleware";

export async function GET() {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;
  try {
    const { localDbStatus, verifyLocalDb } = await import("@/lib/local-db");
    const keptPath = join(process.cwd(), ".orplex", "last-import.json");
    let kept: { name: string; bytes: number } | null = null;
    try {
      const st = await stat(keptPath);
      kept = { name: keptPath, bytes: st.size };
    } catch {
      kept = null;
    }
    return NextResponse.json({
      kept,
      local: localDbStatus(),
      verify: verifyLocalDb(),
    });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
