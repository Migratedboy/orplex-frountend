import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/chat-middleware";
import { getVerifiedModels } from "@/lib/model-catalog";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET /api/models/available
 *
 * Live model catalog for the prompt-bar picker:
 *  - `models`: every model served by the platform's configured providers
 *    (registry defs with a key in .env) that PASSED a real completion probe.
 *    Dead ids can never appear.
 *  - `userModels`: models listed under the user's own keys (BYOK) from the
 *    per-key `modelsCache` written by the Settings "Fetch models" engine.
 *    These are listing-proven (the key reached them), not probe-verified.
 *  - `keysRev`: marker (count + newest key time) that changes when the user's
 *    keys change, so the picker can refetch without a page reload.
 *
 * NEVER blocks on a probe sweep (a full sweep takes minutes): cached results
 * are served instantly, a cold start returns an empty list and the sweep runs
 * in the background — the client re-fetches on its next menu open.
 */
export async function GET(_request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  try {
    const { models, throttledModels, probedAt, providers } = await getVerifiedModels();
    // cold = probe timed out on NVIDIA build.farm warm-up (listed + 4xx-less).
    // Passed through so the picker can tag them instead of silently hiding.
    const coldIds = new Set(models.filter((m) => (m as { cold?: boolean }).cold).map((m) => m.id));

    // BYOK listings from the user's stored keys. Empty caches simply
    // contribute nothing; failures must never break the endpoint.
    let userModels: Array<{ id: string; name: string; provider: string; contextWindow?: number; free?: boolean }> = [];
    let keysRev = "";
    try {
      const keys = await prisma.userApiKey.findMany({
        where: { userId: auth.userId, isActive: true },
        select: { provider: true, modelsCache: true, modelsFetchedAt: true, createdAt: true },
      });
      const newest = keys.reduce<number>(
        (acc, k) => Math.max(acc, k.modelsFetchedAt?.getTime() ?? k.createdAt.getTime()),
        0
      );
      keysRev = `${keys.length}:${newest}`;
      const seen = new Set<string>();
      for (const k of keys) {
        if (!Array.isArray(k.modelsCache)) continue;
        for (const m of k.modelsCache as Array<Record<string, unknown>>) {
          const id = typeof m?.id === "string" ? m.id : "";
          if (!id || seen.has(id)) continue;
          seen.add(id);
          userModels.push({
            id,
            name: typeof m?.name === "string" && m.name ? m.name : id,
            provider: k.provider,
            contextWindow: typeof m?.contextWindow === "number" ? m.contextWindow : undefined,
            free: typeof m?.free === "boolean" ? m.free : undefined,
          });
        }
      }
    } catch {
      /* BYOK section is best-effort */
    }

    return Response.json({
      success: true,
      models,
      coldModelIds: [...coldIds],
      throttledModels,
      probedAt,
      providers,
      userModels,
      keysRev,
    });
  } catch {
    return Response.json(
      { success: true, models: [], throttledModels: [], providers: [], probedAt: new Date().toISOString(), userModels: [], keysRev: "" },
      { status: 200 }
    );
  }
}
