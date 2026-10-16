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
import { NON_CHAT_RE, probeModel, lastProbeFailure, type ProbeFailureKind } from "./model-catalog";

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
  /** Ids the provider actually served, before any safety cap. */
  listedTotal?: number;
  /**
   * True only when the DoS guard dropped entries. Every model the key can
   * reach is returned unless a provider returns an absurd payload — the UI
   * surfaces this so a truncated list is never silently shown as complete.
   */
  truncated?: boolean;
  /** Pages fetched (1 = most providers return everything in one response). */
  pages?: number;
}

const LIST_TIMEOUT_MS = 15_000;
/**
 * DoS guard, NOT a product limit. This used to be 200, which silently threw
 * away more than half of a real OpenRouter catalog (400+ ids) in whatever
 * order the provider happened to return — that is why whole free models were
 * missing from the picker. Real caps now come from `ProviderDef.modelsCap`,
 * and this backstop is far above any provider's genuine catalogue size.
 */
const MAX_MODELS = 2000;
/**
 * How many listing pages to follow when the provider paginates.
 *
 * Defaults to 3 rather than 1 on purpose: following a cursor costs nothing
 * when the provider sent none (the loop breaks immediately), but it means a
 * provider that pages — or one we haven't audited yet — still yields its
 * WHOLE catalogue instead of silently stopping at page one.
 */
const MAX_LIST_PAGES = 3;
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

/**
 * Per-model "is this free to run" signal.
 *
 * OpenRouter encodes it as a `:free` id suffix, but that convention is not
 * OpenRouter-only — any provider can (and some do) use it. So we check the
 * suffix for EVERY provider, then the explicit boolean fields, then pricing.
 * Pricing is read as both string ("0") and number (0) because providers
 * disagree; the previous string-only check silently lost the free badge on
 * every provider that returns numeric pricing.
 */
function detectFree(providerId: string, m: Record<string, unknown>, def: ProviderDef | undefined): boolean | undefined {
  const id = typeof m.id === "string" ? m.id : "";
  if (m.free === true || m.is_free === true || m.isFree === true) return true;
  if (/:free$/i.test(id)) return true;

  const pricing = m.pricing as { prompt?: unknown } | undefined;
  const p = pricing?.prompt;
  const num = typeof p === "string" ? Number(p) : typeof p === "number" ? p : NaN;
  if (Number.isFinite(num)) return num === 0;

  // OpenRouter always reports pricing, so absence means "paid" there. For
  // everyone else, absence means "unknown" — say so instead of guessing.
  if (providerId === "openrouter") return false;
  if (def?.free === false) return false;
  return undefined;
}

/**
 * Display rank: free first, then largest context. Applied BEFORE any cap so
 * that if the DoS guard ever bites, it drops the least useful models instead
 * of an arbitrary slice of the provider's ordering.
 */
function rankForDisplay(a: ListedModel, b: ListedModel): number {
  return Number(b.free ?? false) - Number(a.free ?? false) || (b.contextWindow ?? 0) - (a.contextWindow ?? 0);
}

function normalize(raw: RawListShape, providerId: string): ListedModel[] {
  const list: Array<Record<string, unknown>> = Array.isArray(raw.data) ? raw.data : Array.isArray(raw.models) ? raw.models : [];
  const out: ListedModel[] = [];
  const seen = new Set<string>();
  const def = getProviderDef(providerId);
  for (const m of list) {
    const id = typeof m.id === "string" ? m.id : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // Tail-of-id filter (same rule as the platform catalog).
    if (NON_CHAT_RE.test(id.slice(id.lastIndexOf("/") + 1))) continue;
    const ctx =
      typeof m.context_length === "number"
        ? m.context_length
        : typeof m.context_window === "number"
          ? m.context_window
          : typeof m.contextWindow === "number"
            ? m.contextWindow
            : undefined;
    const free = detectFree(providerId, m, def);
    const displayName = typeof m.display_name === "string" ? m.display_name : "";
    const name = displayName || (typeof m.name === "string" ? m.name : "") || prettify(id);
    out.push({ id, name, contextWindow: ctx, free });
  }
  return out.sort(rankForDisplay);
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
 * Follow a provider's pagination cursor, if it sends one. Covers the shapes in
 * the wild: OpenRouter-style `next_page`, Vercel/Google-style `next` + `after`,
 * and Gemini-style `pageToken` + `has_more`. Returns null when the provider
 * gave us everything (the common case) so the caller makes exactly one request.
 */
function nextPageCursor(json: unknown): { param: string; value: string } | null {
  const j = json as Record<string, unknown> | null;
  if (!j || typeof j !== "object") return null;
  if (typeof j.next_page === "string" && j.next_page) return { param: "page", value: j.next_page };
  if (typeof j.next === "string" && j.next) return { param: "after", value: j.next };
  if (typeof j.next_page_token === "string" && j.next_page_token) return { param: "page_token", value: j.next_page_token };
  if (j.has_more === true && typeof j.pageToken === "string") return { param: "pageToken", value: j.pageToken };
  if (j.has_more === true && typeof j.next_page_token === "string") return { param: "page_token", value: j.next_page_token as string };
  return null;
}

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
  const maxPages = Math.max(1, def.maxListPages ?? MAX_LIST_PAGES);
  const cap = def.modelsCap ?? MAX_MODELS;
  let result: ListModelsResult;
  try {
    // Page 1 (most providers return the entire catalogue here).
    const first = await fetch(url, {
      method: "GET",
      headers: applyKey(headers, apiKey.trim()),
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });

    if (first.status === 401 || first.status === 403) {
      result = { ok: false, models: [], error: "Key rejected by the provider — check the key and its permissions.", status: first.status };
    } else if (first.status === 429) {
      result = { ok: false, models: [], error: "Provider rate limit hit — wait a moment and try again.", status: 429 };
    } else if (!first.ok) {
      result = { ok: false, models: [], error: `Provider responded with HTTP ${first.status}.`, status: first.status };
    } else {
      const ct = first.headers.get("content-type") || "";
      if (!ct.includes("json")) {
        result = { ok: false, models: [], error: "Unexpected response from the provider (not JSON).", status: first.status };
      } else {
        // Accumulate raw entries across pages, then normalize ONCE so dedupe
        // and ranking see the complete catalogue rather than one page.
        let rawJson = (await first.json().catch(() => null)) as RawListShape | null;
        const collected: Array<Record<string, unknown>> = [];
        if (rawJson) collected.push(...(Array.isArray(rawJson.data) ? rawJson.data : Array.isArray(rawJson.models) ? rawJson.models : []));
        let pages = 1;

        while (pages < maxPages && collected.length < cap) {
          const cursor = nextPageCursor(rawJson);
          if (!cursor) break;
          const sep = url.includes("?") ? "&" : "?";
          const nextUrl = `${url}${sep}${cursor.param}=${encodeURIComponent(cursor.value)}`;
          const pageRes = await fetch(nextUrl, {
            method: "GET",
            headers: applyKey(headers, apiKey.trim()),
            signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
          }).catch(() => null);
          if (!pageRes?.ok) break; // partial catalogue beats a hard failure
          const nextJson = (await pageRes.json().catch(() => null)) as RawListShape | null;
          if (!nextJson) break;
          const entries = Array.isArray(nextJson.data) ? nextJson.data : Array.isArray(nextJson.models) ? nextJson.models : [];
          if (entries.length === 0) break;
          collected.push(...entries);
          rawJson = nextJson;
          pages++;
        }

        const models = normalize({ data: collected }, providerId);
        if (models.length === 0) {
          result = { ok: false, models: [], error: "No chat models found for this key — you can still type the model id manually.", status: first.status };
        } else {
          result = { ok: true, models: models.slice(0, cap), listedTotal: models.length, pages };
          if (models.length > cap) result.truncated = true;
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
  /**
   * When NOTHING survived the trial: why. "invalid_key" / "no_credits" /
   * "no_models" / "network" map to distinct user notifications; undefined
   * means at least one model passed (or nothing was probed yet).
   */
  failureKind?: ProbeFailureKind;
  /** Raw provider evidence for the failure (never contains the key). */
  failureDetail?: string;
}

/**
 * Probe up to VERIFY_BUDGET models from the given list with the user's key
 * using a GENUINE trial turn ("hi") per model, spaced to respect free-tier
 * limits. 429 counts as alive (the provider confirmed the model serves).
 * Never automatic — callers must wire this to an explicit user action.
 *
 * When ZERO models survive, `failureKind` explains why (invalid key, empty
 * credits, dead network) so the caller can notify the user precisely.
 */
export async function verifyProviderModels(
  providerId: string,
  apiKey: string,
  models: ListedModel[],
): Promise<VerifiedModelsResult> {
  const def = getProviderDef(providerId);
  if (!def) return { ok: false, models, probedCount: 0, verifiedCount: 0, error: `Unknown provider "${providerId}".` };
  if (!apiKey) return { ok: false, models, probedCount: 0, verifiedCount: 0, error: "API key is required." };
  if (models.length === 0) {
    return {
      ok: false, models, probedCount: 0, verifiedCount: 0,
      failureKind: "no_models",
      error: "The provider listed no chat models for this key.",
    };
  }

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
  const result: VerifiedModelsResult = { ok: true, models: tagged, probedCount: probed, verifiedCount: aliveIds.size };

  if (aliveIds.size === 0 && probed > 0) {
    // Nothing answered the trial — surface the reason the probe recorded.
    const f = lastProbeFailure();
    result.failureKind = f.kind ?? "dead";
    result.failureDetail = f.detail;
    result.error =
      f.kind === "invalid_key"
        ? "Every model failed the trial — the provider rejected the API key."
        : f.kind === "no_credits"
          ? "Every model failed the trial — no credits left on this API key."
          : f.kind === "network"
            ? "Every model failed the trial — the provider could not be reached."
            : "No model answered the trial request.";
  }
  return result;
}
