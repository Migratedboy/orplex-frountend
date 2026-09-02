import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getProviderHealth } from "@/lib/circuit-breaker";
import { getPoolSummary } from "@/lib/key-pool";

export async function GET() {
  try {
    await requireAdmin();
    const health = await getProviderHealth();
    const summary = await getPoolSummary();

    // Group keys by provider for health view
    const byProvider: Record<string, any> = {};
    for (const key of summary.keys) {
      if (!byProvider[key.provider]) {
        byProvider[key.provider] = {
          name: key.provider,
          status: "healthy",
          activeKeys: 0,
          totalUsageToday: 0,
        };
      }
      if (key.isActive) byProvider[key.provider].activeKeys++;
      byProvider[key.provider].totalUsageToday += key.usageToday;
    }

    // Merge circuit breaker status
    for (const h of health) {
      if (byProvider[h.name]) {
        byProvider[h.name].status = h.status;
        byProvider[h.name].failures = h.failures;
      }
    }

    return NextResponse.json({
      providers: Object.values(byProvider),
      circuitBreakers: health,
    });
  } catch (err: any) {
    const status = err.message === "Unauthorized" ? 401 : err.message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}
