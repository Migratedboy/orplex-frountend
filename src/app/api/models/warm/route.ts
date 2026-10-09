import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/chat-middleware";
import { getVerifiedModels, wakeColdModels, forceWakeColdModels, getWakeProgress } from "@/lib/model-catalog";

export const dynamic = "force-dynamic";

/**
 * Cold-start wake engine endpoint (Settings "Warm models" card).
 *
 * GET  — live wake progress. If cold models exist and NO cycle is running,
 *        one is kicked (cooldown-aware) before reporting, so a mere visit to
 *        Settings gets warming started. Response: { running, coldModels,
 *        models: WakeModelState[] } — poll every ~5s for live per-model
 *        attempt/outcome states.
 *
 * POST — body { force?: boolean }. force=true bypasses the cooldown for a
 *        manual "Warm models" click. Returns the same progress shape
 *        immediately; the cycle itself runs detached (a warm-up probe can
 *        take minutes — never block the caller).
 */
async function progressPayload(forceKick: boolean) {
  const { models } = await getVerifiedModels();
  const coldIds = models.filter((m) => (m as { cold?: boolean }).cold).map((m) => m.id);

  const progress = getWakeProgress();
  if (coldIds.length > 0 && !progress.running) {
    // Fire-and-forget: a wake cycle runs many minutes; never block. The
    // .catch keeps a synchronous throw inside the kick from becoming an
    // unhandled rejection (the route's try only covers awaited work).
    if (forceKick) void forceWakeColdModels().catch(() => {});
    else void wakeColdModels().catch(() => {});
  }

  return {
    success: true,
    running: progress.running,
    coldModels: coldIds,
    models: progress.models,
    startedAt: progress.startedAt,
  };
}

export async function GET(_request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;
  try {
    return Response.json(await progressPayload(false));
  } catch {
    return Response.json({ success: false, running: false, coldModels: [], models: [] }, { status: 200 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json().catch(() => ({})) as { force?: boolean };
    return Response.json(await progressPayload(body.force === true));
  } catch {
    return Response.json({ success: false, running: false, coldModels: [], models: [] }, { status: 200 });
  }
}
