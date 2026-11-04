/**
 * model-context-windows.ts — model-id + context-window helpers for the chat
 * hot path. Extracted from /api/chat/route.ts (ui route was assembling
 * payloads AND owning catalog cache lookup logic).
 *
 * `loadContextWindows` is best-effort BY DESIGN: the catalog answers from
 * memory/disk cache instantly and a cold cache simply yields an empty map,
 * which makes resolveMaxOutputTokens fall back to its safe default. It must
 * never throw — it runs on the hot chat path.
 */
import { getVerifiedModels } from "@/lib/model-catalog";

/** Strip an OpenRouter-style namespace: "openai/gpt-4o" -> "gpt-4o". */
export function bareModelId(id: string): string {
  const s = (id || "").trim();
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Model id -> context window, from the (cached) verified catalog. */
export async function loadContextWindows(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const { models } = await getVerifiedModels({ background: true });
    for (const m of models) {
      const ctx = (m as { contextWindow?: number }).contextWindow;
      if (typeof ctx === "number" && ctx > 0) {
        map.set(m.id, ctx);
        const bare = bareModelId(m.id);
        if (bare && !map.has(bare)) map.set(bare, ctx);
      }
    }
  } catch {
    /* catalog unavailable — safe default applies */
  }
  return map;
}

/** Exact window for a model id, or its bare variant ("x/gpt-5" -> "gpt-5"). */
export function contextWindowForModel(
  contextWindows: Map<string, number>,
  id: string
): number | undefined {
  return contextWindows.get((id || "").trim()) ?? contextWindows.get(bareModelId(id));
}
