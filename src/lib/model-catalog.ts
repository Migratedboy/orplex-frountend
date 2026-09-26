/**
 * model-catalog.ts — Live model discovery + verification for the prompt bar.
 *
 * Fetches every model offered by the PLATFORM-configured providers (any
 * registry def whose keyEnvVar is set in .env), then LIVE-PROBES each
 * one with a tiny chat completion. Only models that actually answer are
 * returned, so the picker can never offer a dead id (the DeepSeek-free-tier
 * incident). Results are cached in memory (5 min) and on disk (30 min) so
 * the probe cost is paid at most a few times a day.
 *
 * Probe scope: OpenRouter free models (:free suffix) are probed individually;
 * paid OpenRouter models are probed at a small sample (first 12 by context)
 * since every probe still costs tokens. Other providers' lists are probed
 * fully. Probes run with limited concurrency, registry-specified pacing and
 * an 8s timeout each; a model that times out or errors is excluded.
 */

import { listProviderDefs, getProviderDef, type ProviderDef } from "./provider-registry";

export interface CatalogModel {
  id: string;
  name: string;
  /** Registry provider id ("groq" | "openrouter" | "nvidia" | "anthropic" | …). */
  provider: string;
  /** true when the probe actually answered (all listed models replied) */
  verified: true;
  contextWindow?: number;
  free?: boolean;
  /**
   * Probe hit the provider's rate limit. The provider confirmed the model
   * exists and serves, but it did NOT reply, so per the picker's contract
   * (only models proven to reply are listed) throttled models are EXCLUDED
   * from the catalog. Surfaced here so a sweep can report them separately
   * from genuinely dead models.
   */
  throttled?: boolean;
}

interface CatalogResult {
  models: CatalogModel[];
  /** Confirmed-live models that only answered 429 — reported but not listed. */
  throttledModels: CatalogModel[];
  probedAt: string;
  providers: string[];
}

const MEM_TTL_MS = 5 * 60 * 1000;
const DISK_TTL_MS = 30 * 60 * 1000;
/** After this age a cached list is still served, but a background sweep kicks off. */
const SOFT_TTL_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_CONCURRENCY = 6;
const OPENROUTER_PAID_SAMPLE = 12;
const DISK_CACHE = ".model-catalog-cache.json";

let memCache: { at: number; data: CatalogResult } | null = null;

/** One sweep at a time; a kick during a sweep queues exactly one more. */
let refreshInFlight: Promise<void> | null = null;
let refreshWanted = false;

/**
 * Kick a probe sweep WITHOUT blocking the caller. A full sweep takes minutes
 * (live completion per model + retry passes), so it must never run inside a
 * request. Safe to call repeatedly — concurrent kicks collapse into one run
 * (plus at most one queued follow-up so a stale cache always converges).
 */
export function ensureCatalogRefresh(): void {
  if (refreshInFlight) {
    refreshWanted = true;
    return;
  }
  refreshInFlight = sweepCatalog()
    .then(
      () => undefined,
      (err) => {
        // Never silent: a failed sweep must be visible in the dev log — and
        // since no cache gets written, the next request re-kicks a sweep.
        console.error("[model-catalog] background sweep failed:", err);
        return undefined as void;
      }
    )
    .finally(() => {
      refreshInFlight = null;
      if (refreshWanted) {
        refreshWanted = false;
        ensureCatalogRefresh();
      }
    });
}

// ---------------------------------------------------------------------------
// Disk cache (best-effort; survives dev-server restarts)
// ---------------------------------------------------------------------------

type DiskLibs = { fs: typeof import("fs"); path: typeof import("path") } | null;

function diskLibs(): DiskLibs {
  if (typeof window !== "undefined") return null;
  try {
    // eslint-disable-next-line no-eval
    const req = eval("typeof require === 'function' ? require : null") as ((id: string) => unknown) | null;
    if (!req) return null;
    return { fs: req("fs") as typeof import("fs"), path: req("path") as typeof import("path") };
  } catch {
    return null;
  }
}

function cachePath(libs: NonNullable<DiskLibs>): string {
  return libs.path.join(process.cwd(), DISK_CACHE);
}

function readDiskCache(): CatalogResult | null {
  const libs = diskLibs();
  if (!libs) return null;
  try {
    const raw = libs.fs.readFileSync(cachePath(libs), "utf8");
    const parsed = JSON.parse(raw) as CatalogResult;
    if (Date.now() - new Date(parsed.probedAt).getTime() > DISK_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDiskCache(data: CatalogResult): void {
  const libs = diskLibs();
  if (!libs) return;
  try {
    libs.fs.writeFileSync(cachePath(libs), JSON.stringify(data), "utf8");
  } catch {
    // cache write is best-effort
  }
}

/** Test hook: clear all cached state. */
export function resetModelCatalogForTests(): void {
  memCache = null;
  const libs = diskLibs();
  if (!libs) return;
  try {
    libs.fs.unlinkSync(cachePath(libs));
  } catch {}
}

// ---------------------------------------------------------------------------
// Provider listing
// ---------------------------------------------------------------------------

interface RawModel {
  id: string;
  name?: string;
  context_length?: number;
  contextWindow?: number;
}

/**
 * Ids that are not usable as chat models even when they answer a probe:
 * prompt-injection classifiers, safety routers, audio TTS/STT, etc.
 * Matched on the tail of the id (after the last slash). Exported so the
 * BYOK model-listing engine applies the identical filter.
 */
export const NON_CHAT_RE = /(prompt-guard|safeguard|content-safety|guard-|whisper|orpheus|riva|tts|transcribe|embed|rerank|moderation|safety|parse|ocr)/i;

/** Smallest usable chat context. The app's system prompt + tools alone are
 *  ~8k tokens, so a model with a smaller window (e.g. Groq allam-2-7b @ 4096)
 *  answers every probe but 400s on every real request — never list it. */
const MIN_CONTEXT_TOKENS = 8192;

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

function withTimeout(ms: number): { signal: AbortSignal; done: Promise<void>; cancel: () => void } {
  const ctrl = new AbortController();
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
    setTimeout(() => {
      ctrl.abort();
      resolve();
    }, ms);
  });
  return {
    signal: ctrl.signal,
    done,
    // Called on success: clears the pending abort timer AND resolves `done`,
    // so awaiting probes finish in their actual round-trip time instead of
    // always burning the full timeout window.
    cancel: () => {
      ctrl.abort();
      resolveDone();
    },
  };
}

/**
 * Generic registry-driven listing: GET {origin}{listPath} with the auth
 * style the def declares. Handles OpenAI `data[]` and Anthropic `data[]`
 * shapes plus any provider that lists without a wrapper (`models[]`).
 */
async function listProviderModelsRaw(def: ProviderDef): Promise<RawModel[] | null> {
  try {
    const base = def.baseUrl.replace(/\/+$/, "");
    const url = `${base}${def.listPath ?? "/models"}`;
    const headers: Record<string, string> = {};
    const key = (process.env[def.keyEnvVar] || "").trim();
    if (def.authStyle === "x-api-key") {
      headers["x-api-key"] = key;
      Object.assign(headers, def.extraHeaders ?? {});
    } else {
      headers["Authorization"] = `Bearer ${key}`;
      if (def.extraHeaders) Object.assign(headers, def.extraHeaders);
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<Record<string, unknown>>; models?: Array<Record<string, unknown>> };
    const list: Array<Record<string, unknown>> = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    const out: RawModel[] = [];
    for (const m of list) {
      const id = typeof m.id === "string" ? m.id : "";
      if (!id) continue;
      const displayName = typeof m.display_name === "string" ? m.display_name : "";
      const name = displayName || (typeof m.name === "string" ? m.name : "") || prettify(id);
      const ctx =
        typeof m.context_length === "number" ? m.context_length : typeof m.context_window === "number" ? m.context_window : undefined;
      out.push({ id, name, contextWindow: ctx });
    }
    return out;
  } catch (err) {
    console.warn(`[model-catalog] ${def.id} listing failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Live probe — the "does it actually reply" test
// ---------------------------------------------------------------------------

/** Probe verdict per model. */
type ProbeVerdict = "ok" | "rate_limited" | "dead";

/** Probe one model with a minimal completion. True iff it answers with content. */
export async function probeModel(
  provider: string,
  modelId: string,
  apiKey: string
): Promise<ProbeVerdict> {
  const def = getProviderDef(provider);
  const url = def
    ? `${def.baseUrl}/chat/completions`
    : "https://integrate.api.nvidia.com/v1/chat/completions";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (def?.authStyle === "x-api-key") {
    headers["x-api-key"] = apiKey;
    Object.assign(headers, def.extraHeaders ?? {});
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
    if (def?.extraHeaders) Object.assign(headers, def.extraHeaders);
  }
  const { signal, done, cancel } = withTimeout(PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Reply with the single word: OK" }],
        max_tokens: 16,
        stream: false,
      }),
      signal,
    });
    if (res.status === 429) return "rate_limited"; // busy ≠ dead: the provider acknowledged the model
    if (!res.ok) {
      console.warn(
        `[model-catalog] probe ${provider}/${modelId}: HTTP ${res.status}`
      );
      return "dead";
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      console.warn(`[model-catalog] probe ${provider}/${modelId}: non-JSON response (${ct})`);
      return "dead";
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; reasoning?: string | null } }>;
      error?: { code?: number | string; message?: string };
    };
    // Some providers answer 200 with an embedded error object
    if (json.error) {
      const code = Number(json.error.code ?? 0);
      if (code !== 429) console.warn(`[model-catalog] probe ${provider}/${modelId}: embedded error ${JSON.stringify(json.error).slice(0, 160)}`);
      return code === 429 ? "rate_limited" : "dead";
    }
    // 200 + a choices array = the model served a chat completion. Reasoning
    // models can return empty `content` (their budget went to hidden
    // reasoning — finish_reason "length"), which still proves the model works.
    return Array.isArray(json.choices) && json.choices.length > 0 ? "ok" : "dead";
  } catch (err) {
    // Timeouts land here: Groq queues requests when the per-minute token
    // budget is tight — a queued-then-served response is still proof of life,
    // hence the generous budget. Log so silent kills become diagnosable.
    console.warn(
      `[model-catalog] probe ${provider}/${modelId}: ${err instanceof Error ? err.name + ": " + err.message : String(err)}`
    );
    return "dead";
  } finally {
    cancel();
    await done;
  }
}

/** Map-limited parallel runner preserving input order.
 *
 *  Provider-aware pacing: a provider with probeSpacingMs set (Groq: 1500ms —
 *  its free tier rejects parallel bursts) runs strictly serially with a gap
 *  between starts; everything else shares the concurrency pool. */
type ProbeJob = { provider: string; id: string; key: string };

/**
 * Verdicts are keyed per (provider, id) — the same model id can be listed by
 * several providers (gpt-oss-20b: Groq AND NVIDIA), and one provider's dead
 * endpoint must never erase another's proof of life.
 */
const jobKey = (j: Pick<ProbeJob, "provider" | "id">) => `${j.provider}::${j.id}`;

async function probeAll(
  jobs: ProbeJob[],
): Promise<Map<string, ProbeVerdict>> {
  const verdicts = new Map<string, ProbeVerdict>();

  const spacingFor = (provider: string): number =>
    getProviderDef(provider)?.probeSpacingMs ?? 0;

  const paced = jobs.filter((j) => spacingFor(j.provider) > 0);
  const otherJobs = jobs.filter((j) => spacingFor(j.provider) === 0);

  // One serial lane per paced provider; lanes and the shared pool all run
  // concurrently and are awaited together.
  const pacedLanes: Promise<void>[] = [];
  for (const p of [...new Set(paced.map((j) => j.provider))]) {
    const pJobs = paced.filter((j) => j.provider === p);
    const gap = spacingFor(p);
    const lane = async () => {
      for (let i = 0; i < pJobs.length; i++) {
        const job = pJobs[i];
        verdicts.set(jobKey(job), await probeModel(job.provider, job.id, job.key));
        if (i < pJobs.length - 1) await new Promise((r) => setTimeout(r, gap));
      }
    };
    pacedLanes.push(lane());
  }

  let next = 0;
  const worker = async () => {
    while (next < otherJobs.length) {
      const job = otherJobs[next++];
      verdicts.set(jobKey(job), await probeModel(job.provider, job.id, job.key));
    }
  };

  await Promise.all([
    ...pacedLanes,
    ...Array.from({ length: Math.min(PROBE_CONCURRENCY, otherJobs.length) }, worker),
  ]);

  // Retry pass: a single transient error (a rate-limit blip, a network hiccup)
  // must not kill a model for the whole cache cycle. One quiet re-probe each
  // for verdicts that came back "dead" (throttled is not retried — the provider
  // already confirmed the model serves).
  const deadJobs = jobs.filter((j) => verdicts.get(jobKey(j)) === "dead");
  if (deadJobs.length > 0) {
    // Brief cool-down first: most "dead" verdicts are provider blips (a 5xx,
    // a timeout) that pass immediately on a second attempt.
    await new Promise((r) => setTimeout(r, 3000));
  }
  for (const job of deadJobs) {
    const gap = spacingFor(job.provider);
    if (gap) await new Promise((r) => setTimeout(r, gap));
    verdicts.set(jobKey(job), await probeModel(job.provider, job.id, job.key));
  }
  return verdicts;
}

// ---------------------------------------------------------------------------
// Public entry — getVerifiedModels
// ---------------------------------------------------------------------------

export async function getVerifiedModels(
  opts: { background?: boolean } = {}
): Promise<CatalogResult> {
  if (memCache && Date.now() - memCache.at < MEM_TTL_MS) return memCache.data;
  // NOTE: cache checks only — the actual sweep lives in sweepCatalog() so a
  // background refresh can never be short-circuited by a cache we just set.
  const disk = readDiskCache();
  if (disk) {
    memCache = { at: Date.now(), data: disk };
    // Stale-but-usable: answer instantly from cache and refresh off the
    // request path — a full sweep takes minutes.
    if (!opts.background && Date.now() - new Date(disk.probedAt).getTime() > SOFT_TTL_MS) {
      ensureCatalogRefresh();
    }
    return disk;
  }
  if (memCache) {
    // Expired memory cache with no usable disk copy: still better than a
    // minutes-long stall. Serve it and refresh in the background.
    memCache = { at: Date.now(), data: memCache.data };
    if (!opts.background) ensureCatalogRefresh();
    return memCache.data;
  }
  // Cold start (no cache anywhere): a user-facing request must never wait on
  // the sweep, so answer immediately with an empty catalog and let the
  // background refresher populate it — the client keeps its fallback trio and
  // re-fetches until the real list lands.
  if (!opts.background) {
    ensureCatalogRefresh();
    return { models: [], throttledModels: [], probedAt: new Date().toISOString(), providers: [] };
  }
  return sweepCatalog();
}

/** The full listing + probe sweep. Only ever runs via ensureCatalogRefresh(). */
async function sweepCatalog(): Promise<CatalogResult> {
  // Registry-driven: every platform key present in .env joins the sweep.
  const defs = listProviderDefs().filter((d) => (process.env[d.keyEnvVar] || "").trim() !== "");

  const listing: Array<{ provider: string; raw: RawModel[]; key: string }> = [];
  const providers: string[] = [];
  // Fetches run in parallel, but results land in FIXED registry display
  // order. Pushing on completion would let a slow provider steal the dedupe
  // tag for ids listed by several providers (gpt-oss-120b exists on Groq AND
  // NVIDIA AND OpenRouter).
  const rawLists = await Promise.all(
    defs.map(async (d) => (await listProviderModelsRaw(d)) ?? ([] as RawModel[]))
  );
  defs.forEach((d, i) => {
    providers.push(d.id);
    listing.push({ provider: d.id, raw: rawLists[i], key: (process.env[d.keyEnvVar] || "").trim() });
  });

  // Probe scope: free OpenRouter models + first N paid (by context desc),
  // full lists for the other providers. Dedupes ids (same id can list twice).
  const jobs: Array<{ provider: string; id: string; key: string }> = [];
  for (const l of listing) {
    const seen = new Set<string>();
    let models = l.raw.filter((m) => m.id && !seen.has(m.id) && seen.add(m.id));
    // Strip non-chat offerings up front — classifiers/audio/etc. may answer
    // probes but are useless (and confusing) in a chat picker. Also strip
    // models too small for the app's real request size.
    models = models.filter((m) => !NON_CHAT_RE.test(m.id.slice(m.id.lastIndexOf("/") + 1)));
    models = models.filter(
      (m) => !m.contextWindow || m.contextWindow >= MIN_CONTEXT_TOKENS,
    );
    if (l.provider === "openrouter") {
      const free = models.filter((m) => m.id.endsWith(":free"));
      const paid = models
        .filter((m) => !m.id.endsWith(":free"))
        .sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0))
        .slice(0, OPENROUTER_PAID_SAMPLE);
      models = [...free, ...paid];
    }
    for (const m of models) jobs.push({ provider: l.provider, id: m.id, key: l.key });
  }

  let verdicts = await probeAll(jobs);
  // Retry pass: busy free tiers (Groq especially) rate-limit bursts; models
  // that came back 429 get one more chance after a cool-down before final
  // verdict. A still-throttled model never actually replied, so it does not
  // make the picker — the user asked for "only models proven to work".
  const throttled = jobs.filter((j) => verdicts.get(jobKey(j)) === "rate_limited");
  if (throttled.length > 0) {
    await new Promise((r) => setTimeout(r, 2000));
    const retry = await probeAll(throttled);
    for (const j of throttled) {
      const v = retry.get(jobKey(j));
      if (v) verdicts.set(jobKey(j), v);
    }
  }
  const stillThrottled = new Set(
    jobs.filter((j) => verdicts.get(jobKey(j)) === "rate_limited").map((j) => j.id)
  );

  // Collapse per-(provider,id) verdicts into one per id: best wins, in .env
  // priority order (jobs were pushed groq-first). Groq proving gpt-oss-20b
  // works outranks NVIDIA's copy of the same id timing out.
  const verdictsById = new Map<string, ProbeVerdict[]>();
  for (const j of jobs) {
    const v = verdicts.get(jobKey(j));
    if (!v) continue;
    const arr = verdictsById.get(j.id) ?? [];
    arr.push(v);
    verdictsById.set(j.id, arr);
  }
  const best = (id: string): ProbeVerdict | undefined => {
    const arr = verdictsById.get(id);
    if (!arr || arr.length === 0) return undefined;
    if (arr.includes("ok")) return "ok";
    if (arr.includes("rate_limited")) return "rate_limited";
    return "dead";
  };

  const out: CatalogModel[] = [];
  const throttledOut: CatalogModel[] = [];
  const seenIds = new Set<string>();
  // Listing order follows .env priority (groq → openrouter → nvidia), so the
  // first provider to list an id wins its tag; /api/chat still picks the
  // serving provider itself by model match.
  for (const l of listing) {
    for (const m of l.raw) {
      if (seenIds.has(m.id)) continue;
      const v = best(m.id);
      if (v === "dead" || v === undefined) continue; // only live models listed
      seenIds.add(m.id);
      const entry: CatalogModel = {
        id: m.id,
        name: m.name || prettify(m.id),
        provider: l.provider,
        verified: true,
        contextWindow: m.contextWindow,
        free: l.provider === "openrouter" ? m.id.endsWith(":free") : undefined,
        ...(v === "rate_limited" ? { throttled: true } : {}),
      };
      if (v === "rate_limited") throttledOut.push(entry);
      else out.push(entry);
    }
  }
  // Fully-verified first, then provider + name for stable order.
  out.sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name)
  );

  const data: CatalogResult = {
    models: out,
    throttledModels: throttledOut,
    probedAt: new Date().toISOString(),
    providers,
  };
  memCache = { at: Date.now(), data };
  writeDiskCache(data);
  return data;
}
