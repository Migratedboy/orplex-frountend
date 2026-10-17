import { NextRequest } from "next/server";
import { after } from "next/server";
import { requireAuth } from "@/lib/chat-middleware";
import { getVerifiedModels, modelHealth } from "@/lib/model-catalog";
import { prisma } from "@/lib/prisma";
import { ensureCatalogsFresh } from "@/lib/catalog-sync";

export const dynamic = "force-dynamic";

/**
 * Short-lived response cache, per user.
 *
 * The picker polls this endpoint every few seconds while the catalog is cold,
 * and every call used to run a `prisma.userApiKey.findMany` that selects the
 * FULL `modelsCache` JSON for each of the user's keys, plus the in-memory
 * catalog lookup. That is a lot of repeated work for a list that changes on the
 * order of minutes.
 *
 * 5s TTL: comfortably shorter than any human-perceptible staleness (adding a
 * key, waking a model), while collapsing a burst of polls into one query. Key
 * changes still surface promptly — `keysRev` is recomputed on every cache miss
 * and the client refetches on menu open.
 */
const RESPONSE_CACHE = new Map<string, { at: number; body: unknown }>();
const RESPONSE_TTL_MS = 5_000;
const RESPONSE_CACHE_MAX = 200;

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

  // Collapse a burst of picker polls into one query. The key MUST be the
  // authenticated user: this response carries their BYOK model list, so a
  // shared/global key would serve one user's keys to another.
  const cached = RESPONSE_CACHE.get(auth.userId);
  if (cached && Date.now() - cached.at < RESPONSE_TTL_MS) {
    return Response.json(cached.body);
  }

  try {
    // AUTONOMOUS REPAIR: any key whose catalogue is missing or older than the
    // staleness window is topped up in the background, AFTER this response is
    // already sent. The user never clicks "Fetch models" and never waits on a
    // provider — the picker's next open simply finds a complete catalogue.
    try {
      after(async () => {
        await ensureCatalogsFresh(auth.userId);
      });
    } catch {
      // `after` is unavailable outside a request scope (e.g. a unit test):
      // fall back to a detached promise so the repair still happens.
      void ensureCatalogsFresh(auth.userId).catch(() => {});
    }

    const { models, throttledModels, probedAt, providers, providerIssues } = await getVerifiedModels();
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

    const body = {
      success: true,
      models,
      // Throttled = the provider answered 429, which ACKNOWLEDGES the model
      // serves; it is merely busy right now. These used to be withheld from
      // the picker entirely, which is why OpenRouter — configured, working,
      // and serving 11 models — contributed exactly zero rows: its models were
      // all classified rate_limited and its list was never sent. Shown
      // separately so the picker can label them without pretending they're
      // fully verified.
      throttledModels: throttledModels ?? [],
      // Probe-health per id: "green" = answered a probe <24h ago, "amber" =
      // proof of life has aged out. The picker renders a health dot from it.
      health: Object.fromEntries(
        models.map((m) => [m.id, { health: modelHealth(m), lastVerifiedAt: m.lastVerifiedAt, probeLatencyMs: m.probeLatencyMs }])
      ),
      coldModelIds: [...coldIds],
      probedAt,
      providers,
      // Fix 5: which configured providers contributed ZERO models and why.
      // Without this a dead key or an empty balance looked identical to
      // "this provider has nothing".
      providerIssues: providerIssues ?? [],
      userModels,
      keysRev,
    };

    // Only a fully-built success body is cached. The `catch` fallback below
    // returns an empty list, and caching THAT would keep the picker empty for
    // the whole TTL after one transient failure.
    RESPONSE_CACHE.set(auth.userId, { at: Date.now(), body });
    // Bounded: evict the oldest entries rather than growing without limit.
    while (RESPONSE_CACHE.size > RESPONSE_CACHE_MAX) {
      const oldest = RESPONSE_CACHE.keys().next();
      if (oldest.done) break;
      RESPONSE_CACHE.delete(oldest.value);
    }

    return Response.json(body);
  } catch {
    return Response.json(
      { success: true, models: [], throttledModels: [], coldModelIds: [], providers: [], probedAt: new Date().toISOString(), userModels: [], keysRev: "" },
      { status: 200 }
    );
  }
}
