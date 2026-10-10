// Health check endpoint for load balancers and monitoring
// Returns basic status info without exposing sensitive details

import { NextResponse } from "next/server";
import { appVersion } from "@/lib/app-version";

export async function GET() {
  const checks: Record<string, string> = {};

  // Database connectivity
  try {
    const { prisma } = await import("@/lib/prisma");
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    checks.database = "error";
  }

  // Basic memory check
  const mem = process.memoryUsage();
  checks.memory = `${Math.round(mem.heapUsed / 1024 / 1024)}MB heap`;

  const healthy = checks.database === "ok";

  return NextResponse.json(
    {
      status: healthy ? "healthy" : "degraded",
      version: appVersion(),
      minSupportedAppVersion: process.env.MIN_SUPPORTED_APP_VERSION || null,
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      checks,
    },
    { status: healthy ? 200 : 503 }
  );
}
