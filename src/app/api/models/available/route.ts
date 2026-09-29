import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/chat-middleware";
import { getVerifiedModels, modelHealth } from "@/lib/model-catalog";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET /api/models/available
 *
 * Live model catalog for the prompt-bar picker:
 *  - `models`: every model served by the platform's configured providers
 *    (registry defs with a key in .env) that PASSED a real completion probe.
 *    Dead ids can never appear. Cold ids (probe timed out on NVIDIA
 *    build.farm warm-up) ARE included but flagged, so the picker can hide
 *    them while the wake engine warms them; they arrive here unflagged once
 *    a wake probe answers.
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
    const { models, probedAt, providers } = await getVerifiedModels();
    // cold = probe timed out on NVIDIA build.farm warm-up (listed + 4xx-less).
    // Passed through so the picker can HIDE them while the wake engine warms
    // them — a still-cold model never replied, and the picker's contract is
    // "only models proven to answer". They reappear (unflagged) as soon as a
    // wake probe gets a real completion out of them.
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
      // Probe-health per id: "green" = answered a probe <24h ago, "amber" =
      // proof of life has aged out. The picker renders a health dot from it.
      health: Object.fromEntries(
        models.map((m) => [m.id, { health: modelHealth(m), lastVerifiedAt: m.lastVerifiedAt, probeLatencyMs: m.probeLatencyMs }])
      ),
      coldModelIds: [...coldIds],
      probedAt,
      providers,
      userModels,
      keysRev,
    });
  } catch {
    return Response.json(
      { success: true, models: [], coldModelIds: [], providers: [], probedAt: new Date().toISOString(), userModels: [], keysRev: "" },
      { status: 200 }
    );
  }
}
