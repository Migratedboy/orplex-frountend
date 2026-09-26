// provider-models.ts — BYOK model-listing engine.
//
// Given a provider + the user's API key, fetch that provider's live model
// list (`GET {origin}{listPath}`) and normalize it to the shape the Settings
// UI and the prompt-bar picker consume. This is LISTING only: it proves the
// key works and which models exist, not that a model answers (that's the
// probe's job — see model-catalog.ts probeModel / Phase 8 verify).
//
// Safety properties:
//   - the key is never persisted, logged, or included in errors;
//   - listing results are cached in memory per (provider, key-hash) for
//     10 minutes so opening the picker twice doesn't double-bill anything;
//   - every failure mode maps to a friendly error, never a stack trace.

import { getProviderDef, type ProviderDef } from "./provider-registry";
import { NON_CHAT_RE, probeModel } from "./model-catalog";

export interface ListedModel {
  id: string;
  name: string;
  contextWindow?: number;
  free?: boolean;
}

export interface ListModelsResult {
  ok: boolean;
  models: ListedModel[];
  /** Set when ok — advisory prefix mismatch ("this provider's keys usually start with sk-or-"). */
  warning?: string;
  /** Friendly failure reason when !ok. Never contains the key. */
  error?: string;
  /** HTTP status the provider returned, when known. */
  status?: number;
}

const LIST_TIMEOUT_MS = 15_000;
const MAX_MODELS = 200;
const MEM_TTL_MS = 10 * 60 * 1000;

// --- tiny cache: provider + key-hash → result --------------------------------

const cache = new Map<string, { at: number; result: ListModelsResult }>();

function keyHash(key: string): string {
  // Enough to dedupe identical keys without storing anything reversible.
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function cacheKeyFor(provider: string, apiKey: string): string {
  return `${provider}:${keyHash(apiKey)}`;
}

/** Test hook. */
export function clearProviderModelsCache(): void {
  cache.clear();
}

function cachedGet(cacheKey: string): ListModelsResult | null {
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < MEM_TTL_MS) return hit.result;
  if (hit) cache.delete(cacheKey);
  return null;
}

// --- provider request builders ----------------------------------------------

interface ListRequest {
  url: string;
  headers: Record<string, string>;
}

/** Build the listing request for a provider def. Exported for tests. */
export function buildListRequest(def: ProviderDef): ListRequest {
  // baseUrl looks like https://host/<version-root>; the list endpoint is the
  // origin + version root + listPath ("/models" by default).
  const base = def.baseUrl.replace(/\/+$/, "");
  const url = `${base}${def.listPath ?? "/models"}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (def.authStyle === "x-api-key") {
    headers["x-api-key"] = "__KEY__";
    Object.assign(headers, def.extraHeaders); // anthropic-version etc.
  } else {
    headers["Authorization"] = "Bearer __KEY__";
    Object.assign(headers, def.extraHeaders ?? {});
  }
  return { url, headers };
}

function applyKey(headers: Record<string, string>, apiKey: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = v.replace("__KEY__", apiKey);
  return out;
}

// --- response normalization ---------------------------------------------------

interface RawListShape {
  data?: Array<Record<string, unknown>>;
  models?: Array<Record<string, unknown>>;
}

function normalize(raw: RawListShape, providerId: string): ListedModel[] {
  const list: Array<Record<string, unknown>> = Array.isArray(raw.data) ? raw.data : Array.isArray(raw.models) ? raw.models : [];
  const out: ListedModel[] = [];
  const seen = new Set<string>();
  for (const m of list) {
    const id = typeof m.id === "string" ? m.id : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // Tail-of-id filter (same rule as the platform catalog).
    if (NON_CHAT_RE.test(id.slice(id.lastIndexOf("/") + 1))) continue;
    const def = getProviderDef(providerId);
    const ctx =
      typeof m.context_length === "number"
        ? m.context_length
        : typeof m.context_window === "number"
          ? m.context_window
          : typeof m.contextWindow === "number"
            ? m.contextWindow
            : undefined;
    const pricing = m.pricing as { prompt?: unknown } | undefined;
    const pricingPrompt = pricing && typeof pricing.prompt === "string" ? Number(pricing.prompt) : NaN;
    const free =
      providerId === "openrouter"
        ? id.endsWith(":free")
        : def?.free
          ? undefined
          : Number.isFinite(pricingPrompt)
            ? pricingPrompt === 0
            : undefined;
    const displayName = typeof m.display_name === "string" ? m.display_name : "";
    const name = displayName || (typeof m.name === "string" ? m.name : "") || prettify(id);
    out.push({ id, name, contextWindow: ctx, free });
  }
  return out;
}

/** Stable display name: "deepseek/deepseek-v4:free" → "Deepseek V4". */
function prettify(id: string): string {
  const tail = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  const base = tail.replace(/:free$/, "").replace(/[-_]+/g, " ").trim();
  return base
    .split(" ")
    .filter(Boolean)
    .map((w) => (w.length <= 3 && /\d/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

// --- public entry -------------------------------------------------------------

/**
 * Fetch + normalize a provider's model list with the user's key.
 * Cached 10 min per (provider, key-hash). Never throws.
 */
export async function listProviderModels(providerId: string, apiKey: string): Promise<ListModelsResult> {
  const def = getProviderDef(providerId);
  if (!def) return { ok: false, models: [], error: `Unknown provider "${providerId}".` };
  if (!apiKey || !apiKey.trim()) return { ok: false, models: [], error: "API key is required." };

  const cacheKey = cacheKeyFor(providerId, apiKey);
  const cached = cachedGet(cacheKey);
  if (cached) return cached;

  const { url, headers } = buildListRequest(def);
  let result: ListModelsResult;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: applyKey(headers, apiKey.trim()),
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      result = { ok: false, models: [], error: "Key rejected by the provider — check the key and its permissions.", status: res.status };
    } else if (res.status === 429) {
      result = { ok: false, models: [], error: "Provider rate limit hit — wait a moment and try again.", status: 429 };
    } else if (!res.ok) {
      result = { ok: false, models: [], error: `Provider responded with HTTP ${res.status}.`, status: res.status };
    } else {
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("json")) {
        result = { ok: false, models: [], error: "Unexpected response from the provider (not JSON).", status: res.status };
      } else {
        const raw = (await res.json().catch(() => null)) as RawListShape | null;
        const models = raw ? normalize(raw, providerId).slice(0, MAX_MODELS) : [];
        if (models.length === 0) {
          result = { ok: false, models: [], error: "No chat models found for this key — you can still type the model id manually.", status: res.status };
        } else {
          result = { ok: true, models };
          const prefix = def.keyPrefix;
          if (prefix && !apiKey.trim().startsWith(prefix)) {
            result.warning = `Heads up: ${def.label} keys usually start with "${prefix}" — the provider accepted it anyway.`;
          }
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = {
      ok: false,
      models: [],
      error: msg.includes("aborted") || msg.includes("timeout") ? "Timed out contacting the provider — try again." : "Network error contacting the provider.",
    };
  }

  cache.set(cacheKey, { at: Date.now(), result });
  // Unbounded-growth guard: keep the newest 200 entries.
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return result;
}

// --- BYOK verify: budget-guarded live probing of a stored listing ------------

/** Max models probed per Verify action — every probe spends the user's credits. */
const VERIFY_BUDGET = 12;
const VERIFY_SPACING_MS = 1_200;

export interface VerifiedModelsResult {
  ok: boolean;
  models: Array<ListedModel & { verified?: boolean }>;
  probedCount: number;
  verifiedCount: number;
  error?: string;
}

/**
 * Probe up to VERIFY_BUDGET models from the given list with the user's key,
 * spaced to respect free-tier limits. 429 counts as alive (the provider
 * confirmed the model serves). Never automatic — callers must wire this to
 * an explicit user action.
 */
export async function verifyProviderModels(
  providerId: string,
  apiKey: string,
  models: ListedModel[],
): Promise<VerifiedModelsResult> {
  const def = getProviderDef(providerId);
  if (!def) return { ok: false, models, probedCount: 0, verifiedCount: 0, error: `Unknown provider "${providerId}".` };
  if (!apiKey) return { ok: false, models, probedCount: 0, verifiedCount: 0, error: "API key is required." };

  // Probe priority: free models first (cheapest), then by context window —
  // the flagship models users will actually pick.
  const candidates = [...models]
    .sort((a, b) => Number(b.free ?? false) - Number(a.free ?? false) || (b.contextWindow ?? 0) - (a.contextWindow ?? 0))
    .slice(0, VERIFY_BUDGET);

  const aliveIds = new Set<string>();
  let probed = 0;
  for (const [i, m] of candidates.entries()) {
    const verdict = await probeModel(providerId, m.id, apiKey);
    probed++;
    if (verdict !== "dead") aliveIds.add(m.id);
    if (i < candidates.length - 1) await new Promise((r) => setTimeout(r, VERIFY_SPACING_MS));
  }

  const tagged = models.map((m) => (aliveIds.has(m.id) ? { ...m, verified: true } : m));
  return { ok: true, models: tagged, probedCount: probed, verifiedCount: aliveIds.size };
}
