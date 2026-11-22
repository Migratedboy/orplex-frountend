/**
 * context-limit.ts — how large is the selected model's context window?
 *
 * Three sources, in order of trust:
 *   1. the verified model catalog (`contextWindow` from the provider feed),
 *   2. the app's own model registry (`DEFAULT_MODELS[].detail`, e.g.
 *      "free · 200K · tools"), which is what the picker shows the user,
 *   3. a conservative 32k with `estimated: true` so the UI can say so.
 *
 * Router models ("Free Models Router", key `openrouter/free`) have no window
 * of their own: they land on one of the tier models. Use the model that
 * actually served the last call when we know it, otherwise the smallest window
 * among the routable models (the safe reading — the ring must never promise
 * room the next routed call may not have).
 */

import { DEFAULT_MODELS } from "@/lib/default-models";
import { TIER_MODELS } from "@/lib/model-router";
import { bareModelId, contextWindowForModel, loadContextWindows } from "@/lib/model-context-windows";
import { FALLBACK_CONTEXT_LIMIT } from "@/lib/context-usage";

/** The picker's router row — no single underlying model. */
export const ROUTER_MODEL_KEY = "openrouter/free";

export interface ContextLimit {
  limit: number;
  /** True when we fell back to FALLBACK_CONTEXT_LIMIT. */
  estimated: boolean;
  /** For router rows: the model the window was taken from. */
  resolvedModel: string | null;
}

/** "200K" / "1M" / "262K" → 200_000 / 1_000_000 / 262_000. */
export function parseContextSize(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /(\d+(?:\.\d+)?)\s*([KM])\b/i.exec(text);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * (m[2].toUpperCase() === "M" ? 1_000_000 : 1_000));
}

/** Window advertised by the app's own model registry row for `modelId`. */
export function registryContextSize(modelId: string): number | null {
  const id = (modelId || "").trim();
  if (!id) return null;
  const row =
    DEFAULT_MODELS.find((m) => m.key === id) ??
    DEFAULT_MODELS.find((m) => bareModelId(m.key) === bareModelId(id));
  return parseContextSize(row?.detail ?? null);
}

/** True when the picker row is the free router rather than a single model. */
export function isRouterModel(modelId: string | null | undefined): boolean {
  const id = (modelId || "").trim();
  if (!id) return false;
  const row = DEFAULT_MODELS.find((m) => m.key === id);
  return id === ROUTER_MODEL_KEY || /router/i.test(row?.name ?? "");
}

/**
 * Resolve the window for `modelId`.
 *
 * `lastServedModel` is the model id the provider reported for this
 * conversation's previous turn — the only way to know where the router landed.
 */
export async function resolveContextLimit(
  modelId: string | null | undefined,
  lastServedModel?: string | null,
): Promise<ContextLimit> {
  const windows = await loadContextWindows();
  const requested = (modelId || "").trim();

  const lookup = (id: string | null | undefined): number | null => {
    if (!id) return null;
    const fromCatalog = contextWindowForModel(windows, id);
    if (fromCatalog && fromCatalog > 0) return fromCatalog;
    return registryContextSize(id);
  };

  if (isRouterModel(requested) || !requested) {
    const served = lastServedModel ? lookup(lastServedModel) : null;
    if (served) return { limit: served, estimated: false, resolvedModel: lastServedModel ?? null };
    const routable = Object.values(TIER_MODELS)
      .map((m) => lookup(m.model))
      .filter((n): n is number => !!n && n > 0);
    if (routable.length > 0) {
      return { limit: Math.min(...routable), estimated: false, resolvedModel: null };
    }
    return { limit: FALLBACK_CONTEXT_LIMIT, estimated: true, resolvedModel: null };
  }

  const exact = lookup(requested);
  if (exact) return { limit: exact, estimated: false, resolvedModel: requested };
  return { limit: FALLBACK_CONTEXT_LIMIT, estimated: true, resolvedModel: requested };
}
