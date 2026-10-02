import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getUsageStats } from "@/lib/rate-limiter";

export async function GET() {
  try {
    await requireAdmin();
    const stats = await getUsageStats();
    return NextResponse.json(stats);
  } catch (err: any) {
    const status = err.message === "Unauthorized" ? 401 : err.message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}
