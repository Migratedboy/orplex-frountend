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
  /**
   * Probe TIMED OUT without an HTTP error — NVIDIA build.farm cold-loads
   * model functions on first invocation, so a freshly listed model can hang
   * for minutes then work fine (kimi-k3 did exactly this). The model stays
   * IN the catalog (listed = the provider offers it right now), flagged so
   * the picker renders it tagged "cold" instead of pretending it verified.
   */
  cold?: boolean;
  /**
   * ISO timestamp of the last probe that actually ANSWERED ("ok"). The
   * picker's health dot is green while this is under FRESH_VERIFIED_MS and
   * amber once it ages past it — proof-of-life decays, listings don't.
   */
  lastVerifiedAt?: string;
  /** Round-trip ms of the most recent answering probe — relative speed signal. */
  probeLatencyMs?: number;
}

export interface CatalogResult {
  models: CatalogModel[];
  /** Confirmed-live models that only answered 429 - reported but not listed. */
  throttledModels: CatalogModel[];
  probedAt: string;
  providers: string[];
  /**
   * Per-provider sweep triage. `lastFailureKind` was computed on every failed
   * probe but NEVER read by the sweep, so an invalid key or an empty balance
   * was indistinguishable from "these models are dead" — the app rendered a
   * silently missing provider and said nothing. The picker surfaces these.
   */
  providerIssues?: ProviderIssue[];
}

export interface ProviderIssue {
  provider: string;
  kind: ProbeFailureKind;
  detail: string;
  /** How many models hit this failure. */
  count: number;
  /** How many of that provider's models ended up in the picker anyway. */
  liveCount: number;
}

/** A model verified more recently than this is green and skips re-probing. */
export const FRESH_VERIFIED_MS = 24 * 60 * 60 * 1000;

/**
 * True when the model's last ANSWERING probe is younger than a day —
 * health is fresh, no new probe needed this sweep.
 */
export function isFreshlyVerified(m: CatalogModel, nowMs: number = Date.now()): boolean {
  if (!m.lastVerifiedAt) return false;
  const t = new Date(m.lastVerifiedAt).getTime();
  return Number.isFinite(t) && nowMs - t < FRESH_VERIFIED_MS;
}

/**
 * Picker health dot: "green" = answered a probe within the last day,
 * "amber" = listed and once-verified but proof of life has aged out (or
 * predates health tracking). Exported for tests + the picker payload.
 */
export function modelHealth(m: CatalogModel, nowMs: number = Date.now()): "green" | "amber" {
  return isFreshlyVerified(m, nowMs) ? "green" : "amber";
}

const MEM_TTL_MS = 5 * 60 * 1000;
const DISK_TTL_MS = 30 * 60 * 1000;
/** After this age a cached list is still served, but a background sweep kicks off. */
const SOFT_TTL_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_CONCURRENCY = 6;
const OPENROUTER_PAID_SAMPLE = 12;
const DISK_CACHE = ".model-catalog-cache.json";

// === Cold-start wake engine ================================================
// NVIDIA build.farm cold-loads a model's function on first invocation: the
// first request can hang for minutes, then the model works fine forever
// (kimi-k3 did exactly this). A probe-timeout therefore does NOT mean dead —
// but per the picker's contract (only models PROVEN to answer are listed)
// a still-cold model must not appear either. This engine RE-PROBES cold
// models in the background with generous warm-up timeouts until they answer,
// then promotes them into the verified catalog.
/** Warm-up attempts per model per wake cycle. */
const WAKE_ATTEMPTS = 3;
/** First attempt timeout — the cold-load itself can take minutes. */
const WAKE_TIMEOUT_MS = [120_000, 90_000, 60_000] as const;
/** Gap between wake attempts on the same model. */
const WAKE_RETRY_GAP_MS = 5_000;
/** Gap between different models' wake jobs (NVIDIA free tier pacing). */
const WAKE_SPACING_MS = 2_000;
/** Max models woken per cycle — wake jobs are cheap but bounded anyway. */
const WAKE_MAX_MODELS = 8;
/** How long a wake-cycle result is trusted before models may need re-waking. */
const WAKE_COOLDOWN_MS = 60 * 60 * 1000;

let wakeInFlight: Promise<void> | null = null;
let lastWakeAt = 0;

// === Live wake progress (Settings "Warm models" card) ======================
// The wake cycle runs for many minutes (a single cold-load probe can take
// 2 minutes), so the UI polls this state instead of guessing. `attempt`
// counts 1-based within WAKE_ATTEMPTS; `done` models keep their final
// outcome after the cycle ends so the card can show the last run's result.
export interface WakeModelState {
  id: string;
  /** "waking" = attempt in progress, "woke" = answered, "dead" = HTTP error, "failed" = all attempts exhausted. */
  state: "waking" | "woke" | "dead" | "failed";
  attempt: number;
  totalAttempts: number;
}
export interface WakeProgress {
  running: boolean;
  startedAt: number | null;
  models: WakeModelState[];
}
let wakeProgress: WakeProgress = { running: false, startedAt: null, models: [] };

/** Live (or last-run) wake-cycle progress, for the Settings warm card. */
export function getWakeProgress(): WakeProgress {
  return { ...wakeProgress, models: wakeProgress.models.map((m) => ({ ...m })) };
}

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
    const req = eval("typeof require === 'function' ? require : null") as ((id: string) => unknown) | null; // eval: bundler-proof require access
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
  // Keep the handle so `cancel` can clear it. The comment below claimed the
  // timer was cleared but no clearTimeout existed: every probe left a live
  // timer for its FULL budget (20s sweep / 120s wake), holding the
  // AbortController and closure alive and keeping the event loop referenced.
  // A 500-model sweep leaked hundreds of pending timers.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
    timer = setTimeout(() => {
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
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
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
    console.warn(`[model-catalog] ${def.id} listing failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Live probe — the "does it actually reply" test
// ---------------------------------------------------------------------------

/** Probe verdict per model. */
type ProbeVerdict = "ok" | "rate_limited" | "cold_start" | "dead";

/**
 * Why a probe failed — the user-facing triage. "dead" hides the model from
 * the picker; the other kinds surface a notification (invalid key, empty
 * credits, no models at all) so the user knows WHY nothing showed up.
 */
export type ProbeFailureKind = "invalid_key" | "no_credits" | "no_models" | "network" | "dead";

/** Classify an HTTP status / provider error into the user-facing kind. */
function classifyFailure(status: number, message: string): ProbeFailureKind {
  // Key identity problems: provider refused auth or the key lacks scope.
  if (status === 401 || status === 403) return "invalid_key";
  // Money problems: 402 Payment Required is the canonical "no credits";
  // many providers also emit explicit quota/billing messages.
  if (status === 402) return "no_credits";
  if (/insufficient (?:credits?|funds|quota|balance)|out of credits|credit balance|exceeded your (?:quota|billing)|billing|payment required|no active subscription/i.test(message)) {
    return "no_credits";
  }
  if (/invalid.{0,20}api.?key|invalid.{0,20}token|unauthorized|authentication|api key (?:not|is) (?:valid|invalid|recognized)/i.test(message)) {
    return "invalid_key";
  }
  if (status === 404 || status === 400) return "dead";
  if (status === 0 || status >= 500) return "network";
  return "dead";
}

/**
 * A genuine human-style trial message — exactly what a user would type.
 * Providers' bot-detection and content filters treat degenerate probes
 * ("OK", empty) differently from real turns; this is a real turn.
 */
const TRIAL_MESSAGES = ["hi", "hello", "hey there", "hi!", "Hello!"];
function trialMessage(): string {
  return TRIAL_MESSAGES[Math.floor(Math.random() * TRIAL_MESSAGES.length)];
}

/** Probe one model with a minimal completion. True iff it answers with content. */
/**
 * Failure detail from the MOST RECENT probe — module-level because a failing
 * key (bad key, no credits, dead network) fails EVERY probe identically, so
 * the first failure's classification is the answer for the whole batch.
 * Read by verifyProviderModels after its run to explain a 0-survivor result.
 */
let lastFailureKind: ProbeFailureKind | null = null;
let lastFailureDetail = "";

/** Test/inspection hook. */
export function lastProbeFailure(): { kind: ProbeFailureKind | null; detail: string } {
  return { kind: lastFailureKind, detail: lastFailureDetail };
}

export async function probeModel(
  provider: string,
  modelId: string,
  apiKey: string,
  /** Custom timeout — the wake engine passes generous cold-load windows. */
  timeoutMs: number = PROBE_TIMEOUT_MS
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
  const { signal, done, cancel } = withTimeout(timeoutMs);
  // Routine provider rejections (402 no-credits, 403/404 unknown model,
  // AbortError timeouts) are EXPECTED during a sweep of hundreds of models —
  // log them once per provider as a tally instead of one console line each
  // (the dev log was drowning: ~670 catalog lines per session).
  const tally = sweepTally.get(provider) ?? { dead: 0, other: 0 };
  sweepTally.set(provider, tally);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: modelId,
        // The genuine trial: a real human-style turn ("hi"), like a user's
        // first message. Proves the model ANSWERS, not just that the route
        // exists.
        messages: [{ role: "user", content: trialMessage() }],
        max_tokens: 16,
        stream: false,
      }),
      signal,
    });
    if (res.status === 429) return "rate_limited"; // busy ≠ dead: the provider acknowledged the model
    if (!res.ok) {
      const detail = await res.text().catch(() => "").then((t) => t.slice(0, 300));
      lastFailureKind = classifyFailure(res.status, detail);
      recordProviderFailure(provider, lastFailureKind, lastFailureDetail ?? `HTTP ${res.status}`);
      if (lastFailureKind === "invalid_key" || lastFailureKind === "no_credits" || lastFailureKind === "network") {
        lastFailureDetail = `HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`;
      }
      tally.dead++;
      return "dead";
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      tally.other++;
      return "dead";
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; reasoning?: string | null } }>;
      error?: { code?: number | string; message?: string };
    };
    // Some providers answer 200 with an embedded error object
    if (json.error) {
      const code = Number(json.error.code ?? 0);
      const msg = String(json.error.message || "");
      if (code === 429) return "rate_limited";
      lastFailureKind = classifyFailure(code, msg);
      recordProviderFailure(provider, lastFailureKind, lastFailureDetail ?? (code ? `code ${code}` : "error"));
      if (lastFailureKind === "invalid_key" || lastFailureKind === "no_credits" || lastFailureKind === "network") {
        lastFailureDetail = `${code ? `code ${code}` : "error"}${msg ? `: ${msg.slice(0, 160)}` : ""}`;
      }
      tally.dead++;
      return "dead";
    }
    // 200 + a choices array = the model served a chat completion. Reasoning
    // models can return empty `content` (their budget went to hidden
    // reasoning — finish_reason "length"), which still proves the model works.
    return Array.isArray(json.choices) && json.choices.length > 0 ? "ok" : "dead";
  } catch (err) {
    // Timeouts land here. Two very different causes:
    //  - Groq queues under token-budget pressure — queued-then-served is
    //    still proof of life, hence the generous budget.
    //  - NVIDIA build.farm cold-loads model functions: a freshly listed
    //    model can hang past ANY timeout on its first invocations, then
    //    work fine minutes later (kimi-k3 did exactly this). Treating that
    //    as dead permanently removes working models from the picker.
    // A listed model whose probe only TIMED OUT (never 4xx'd) is marked
    // cold_start: kept in the picker, tagged "cold", visibly separate from
    // probe-verified rows. Only the HTTP-error paths below return "dead".
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError" || /timeout|abort/i.test(err.message));
    if (timedOut && provider === "nvidia") {
      tally.other++;
      return "cold_start";
    }
    if (timedOut) {
      lastFailureKind = "network";
      lastFailureDetail = "trial request timed out";
    } else {
      lastFailureKind = "network";
      lastFailureDetail = String((err as Error)?.message || "network error").slice(0, 160);
    }
    tally.dead++;
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

/** Latency of the most recent probeAll, per job key (health telemetry). */
const latenciesByJob = new Map<string, number>();

async function probeAll(
  jobs: ProbeJob[],
): Promise<Map<string, ProbeVerdict>> {
  const verdicts = new Map<string, ProbeVerdict>();
  // Round-trip ms per job — health telemetry (picker's green/amber dot and
  // the relative speed signal), not used for verdicts.
  //
  // Scope the reset to THIS call's jobs. sweepCatalog runs probeAll TWICE
  // (initial pass, then a rate-limited retry pass), and a blanket .clear()
  // made the second call erase every latency the first one recorded — which is
  // why 15 of 16 models in the live cache had no probeLatencyMs at all.
  for (const j of jobs) latenciesByJob.delete(jobKey(j));

  const spacingFor = (provider: string): number =>
    getProviderDef(provider)?.probeSpacingMs ?? 0;

  const paced = jobs.filter((j) => spacingFor(j.provider) > 0);
  const otherJobs = jobs.filter((j) => spacingFor(j.provider) === 0);

  // One serial lane per paced provider; lanes and the shared pool all run
  // concurrently and are awaited together.
  const timed = async (job: ProbeJob): Promise<ProbeVerdict> => {
    const t0 = Date.now();
    const v = await probeModel(job.provider, job.id, job.key);
    latenciesByJob.set(jobKey(job), Date.now() - t0);
    return v;
  };

  const pacedLanes: Promise<void>[] = [];
  for (const p of [...new Set(paced.map((j) => j.provider))]) {
    const pJobs = paced.filter((j) => j.provider === p);
    const gap = spacingFor(p);
    const lane = async () => {
      for (let i = 0; i < pJobs.length; i++) {
        const job = pJobs[i];
        verdicts.set(jobKey(job), await timed(job));
        if (i < pJobs.length - 1) await new Promise((r) => setTimeout(r, gap));
      }
    };
    pacedLanes.push(lane());
  }

  let next = 0;
  const worker = async () => {
    while (next < otherJobs.length) {
      const job = otherJobs[next++];
      verdicts.set(jobKey(job), await timed(job));
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
  //
  // `background: true` used to `return sweepCatalog()` here, i.e. run the
  // whole multi-minute probe sweep INLINE. Its only caller is
  // loadContextWindows() on the /api/chat hot path, whose own doc comment
  // claimed "a cold cache simply yields an empty map" — which was false. On a
  // fresh instance (empty filesystem) the first chat message blocked for
  // minutes. Kick and answer instead; the next request reads a warm cache.
  ensureCatalogRefresh();
  return { models: [], throttledModels: [], probedAt: new Date().toISOString(), providers: [] };
}

/** Per-provider dead/other tallies for the current sweep — probeModel logs once per provider instead of per model. */
/** Per-provider sweep tally — replaced once per sweep. */
const sweepTally = new Map<string, { dead: number; other: number }>();
/**
 * Attribute one failed probe to its provider. Actionable kinds
 * (invalid_key / no_credits / network) replace whatever was recorded before;
 * generic "dead" only records a count, so it can never mask a real cause.
 */
function recordProviderFailure(provider: string, kind: ProbeFailureKind, detail: string): void {
  failureCountByProvider.set(provider, (failureCountByProvider.get(provider) ?? 0) + 1);
  if (kind === "dead") return;
  failureKindByProvider.set(provider, kind);
  if (detail) failureDetailByProvider.set(provider, detail);
}
/** Per-provider dominant failure — populated by probeModel, read by the sweep (fix 5). */
const failureKindByProvider = new Map<string, ProbeFailureKind>();
const failureDetailByProvider = new Map<string, string>();
const failureCountByProvider = new Map<string, number>();

/**
 * Sweep entry point with a hard concurrency guard.
 *
 * `refreshInFlight` only protected `ensureCatalogRefresh`, so DIRECT callers —
 * `getVerifiedModels({ background: true })` (the chat hot path) and
 * `runSweepForTests()` — bypassed it. On a cold instance the disk cache is
 * empty, `memCache` is only assigned at the END of a sweep, and every
 * concurrent cold-start chat request therefore launched its OWN full sweep:
 * N requests => N simultaneous sweeps => doubled probe cost and a
 * self-inflicted rate-limit storm that (via the rate_limited/dead
 * classification) removed models from the picker.
 *
 * Everyone now shares one in-flight sweep.
 */
let sweepInFlight: Promise<CatalogResult> | null = null;
function sweepCatalog(): Promise<CatalogResult> {
  if (sweepInFlight) return sweepInFlight;
  sweepInFlight = sweepCatalogInner().finally(() => {
    sweepInFlight = null;
  });
  return sweepInFlight;
}

/** The full listing + probe sweep. Always entered through sweepCatalog(). */
async function sweepCatalogInner(): Promise<CatalogResult> {
  sweepTally.clear();
  // Per-provider triage is per-SWEEP. Never left module-global across runs:
  // a stale kind from an unrelated earlier sweep would be attributed to
  // whatever ran next.
  failureKindByProvider.clear();
  failureDetailByProvider.clear();
  failureCountByProvider.clear();
  // Registry-driven: every platform key present in .env joins the sweep.
  const defs = listProviderDefs().filter((d) => (process.env[d.keyEnvVar] || "").trim() !== "");

  // Previous catalog — health carry-forward. A model verified under a day
  // ago (green dot) SKIPS probing entirely: its proof of life is fresh, and
  // re-probing hundreds of models every sweep burns free-tier quota for no
  // information. Freshness rides the (provider, id) pair like verdicts do.
  const prev = memCache?.data ?? readDiskCache();
  const prevHealth = new Map<string, CatalogModel>();
  for (const m of prev?.models ?? []) prevHealth.set(`${m.provider}::${m.id}`, m);

  const listing: Array<{ provider: string; raw: RawModel[]; key: string }> = [];
  const providers: string[] = [];
  const out_carried = new Set<string>();
  const carriedFromFailedProvider: CatalogModel[] = [];
  // Fetch in parallel, but KEEP the null sentinel: `null` means "this provider's
  // listing FAILED" (429/500/DNS/15s timeout) and is completely different from
  // "the provider listed nothing". Collapsing the two used to delete every one
  // of a provider's models for the whole cache cycle on a single blip —
  // including models that were freshly verified and therefore skipped probing.
  const rawLists = await Promise.all(defs.map((d) => listProviderModelsRaw(d)));
  const failedProviders = new Set<string>();
  defs.forEach((d, i) => {
    providers.push(d.id);
    const raw = rawLists[i];
    if (raw === null) failedProviders.add(d.id);
    listing.push({ provider: d.id, raw: raw ?? [], key: (process.env[d.keyEnvVar] || "").trim() });
  });
  if (failedProviders.size > 0) {
    // Carry those providers' last-known models forward rather than dropping
    // them. Their health ages normally; only a provider that LISTS the model
    // and then refuses it should ever remove it.
    for (const m of prev?.models ?? []) {
      if (!failedProviders.has(m.provider)) continue;
      const already = out_carried.has(`${m.provider}::${m.id}`);
      if (already) continue;
      out_carried.add(`${m.provider}::${m.id}`);
      carriedFromFailedProvider.push(m);
    }
    console.warn(
      `[model-catalog] listing failed for ${[...failedProviders].join(", ")} — carrying forward ${carriedFromFailedProvider.length} known model(s) instead of dropping them`
    );
  }

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
    for (const m of models) {
      const prior = prevHealth.get(`${l.provider}::${m.id}`);
      if (prior && isFreshlyVerified(prior)) continue; // green — skip re-probe
      jobs.push({ provider: l.provider, id: m.id, key: l.key });
    }
  }
  const freshSkipped = (prev?.models ?? []).filter((m) => isFreshlyVerified(m)).length;
  if (freshSkipped > 0) console.log(`[model-catalog] sweep: ${freshSkipped} model(s) verified <24h ago — skipping their probes`);

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
    // cold_start (NVIDIA build.farm warm-up) outranks dead only when every
    // provider listing it timed out — one provider actually answering wins.
    if (arr.includes("cold_start")) return "cold_start";
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
      const prior = prevHealth.get(`${l.provider}::${m.id}`);
      // Fresh-verified models were never probed this sweep (no verdict):
      // carry their last health forward untouched so the dot stays green.
      if (prior && isFreshlyVerified(prior)) {
        seenIds.add(m.id);
        // Preserve a previously-known contextWindow when the listing omits it.
        // Groq and NVIDIA don't report context_length, so `m.contextWindow`
        // is undefined for most models — assigning it directly ERASED the
        // value every sweep, which silently degraded both the picker's "131k"
        // badge and every context-window consumer downstream.
        out.push({ ...prior, name: m.name || prior.name, contextWindow: m.contextWindow ?? prior.contextWindow });
        continue;
      }
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
      if (v === "rate_limited") {
        throttledOut.push(entry);
      } else {
        if (v === "cold_start") {
          entry.cold = true;
        } else {
          // Actually answered ("ok") — stamp proof of life + latency. A
          // previously-cold model keeps its historical lastVerifiedAt only
          // via the carry-forward path above; a fresh "ok" overwrites.
          entry.lastVerifiedAt = new Date().toISOString();
          const lat = latenciesByJob.get(`${l.provider}::${m.id}`);
          if (Number.isFinite(lat)) entry.probeLatencyMs = lat;
        }
        out.push(entry);
      }
    }
  }
  // Models from providers whose listing failed this sweep (see the rawLists
  // fetch above). Appended last so a provider that DID list still wins the
  // dedupe tag, and only when the id isn't already present.
  for (const m of carriedFromFailedProvider) {
    if (seenIds.has(m.id)) continue;
    seenIds.add(m.id);
    out.push(m);
  }
  // Per-provider triage (fix 5): a provider whose models all failed for the
  // SAME actionable reason (invalid key, no credits, network) gets reported so
  // the user sees WHY their provider contributes nothing — instead of the
  // picker silently omitting it. A provider with any live model is not an
  // "issue" even if some of its models are dead.
  const providerIssues: ProviderIssue[] = [];
  for (const p of providers) {
    if (out.some((m) => m.provider === p) || throttledOut.some((m) => m.provider === p)) continue;
    const kind = failureKindByProvider.get(p);
    if (!kind) continue;
    providerIssues.push({
      provider: p,
      kind,
      detail: failureDetailByProvider.get(p) ?? "",
      count: failureCountByProvider.get(p) ?? 0,
      liveCount: 0,
    });
  }
  if (providerIssues.length > 0) {
    for (const i of providerIssues) {
      console.warn(`[model-catalog] provider "${i.provider}" contributed 0 models — ${i.kind}${i.detail ? `: ${i.detail}` : ""} (${i.count} failed probe(s))`);
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
    providerIssues,
  };
  // One summary line per sweep replaces the old per-model warning flood.
  const tallyLine = [...sweepTally.entries()]
    .filter(([, t]) => t.dead > 0 || t.other > 0)
    .map(([p, t]) => `${p}: ${t.dead} dead${t.other ? `/${t.other} other` : ""}`)
    .join(", ");
  if (tallyLine) {
    console.log(
      `[model-catalog] sweep done — ${out.length} live, ${throttledOut.length} throttled (${tallyLine})`
    );
  }
  // Refuse to persist a DEGENERATE catalog. An all-listing-failure sweep
  // produces out=[], and writing that with a fresh probedAt made the next 30
  // minutes serve "no models" from a poisoned cache. Keep serving the last
  // good catalog instead and say so loudly.
  const prevModelCount = prev?.models.length ?? 0;
  const degenerate = out.length === 0 && prevModelCount > 0;
  if (degenerate) {
    console.warn(
      `[model-catalog] sweep produced 0 models but the previous catalog had ${prevModelCount} — refusing to overwrite the disk cache (every provider listing probably failed)`
    );
    if (prev) {
      memCache = { at: Date.now(), data: prev };
      return prev;
    }
  }
  memCache = { at: Date.now(), data };
  writeDiskCache(data);
  // Cold models must not wait for the next sweep (~30 min): kick the wake
  // engine right away so they join the picker as soon as they answer.
  if (out.some((m) => m.cold)) wakeColdModels();
  return data;
}

// ---------------------------------------------------------------------------
// Cold-start wake engine — turn "probe timed out" into "verified" over time
// ---------------------------------------------------------------------------

/**
 * Announce that a cold model answered and joined the picker.
 *
 * This module exists in TWO copies (the app and the backend). Both run sweeps,
 * but only the backend copy used to notify — so promotions performed by this
 * copy were silent, and TopBar's "Cold model woke up" listener plus the
 * `orplex:wake-promoted` bridge fired for nobody.
 *
 * notify() is next-auth/Prisma-backed, which must never enter the UI bundle,
 * so it is reached through a dynamic import and its absence (client realm) is
 * not an error. The window event is the transport the picker actually listens
 * to; the durable notification is a bonus for the server realm.
 */
function notifyWakePromotion(modelId: string): void {
  if (!modelId) return;
  // Transport the picker actually listens to — works in both realms.
  try {
    window.dispatchEvent(new CustomEvent("orplex:wake-promoted", { detail: { id: modelId } }));
  } catch {}
  // Durable bell notification, server realm only. notify() pulls in
  // next-auth + @prisma/client, which must never enter the UI bundle, so it is
  // behind a dynamic import guarded by a realm check and a dynamic require so
  // the bundler leaves it alone. Any failure is swallowed — a promotion that
  // can't announce itself must still count as promoted.
  if (typeof window !== "undefined") return;
  void (async () => {
    try {
      const req = eval("typeof require === 'function' ? require : null") as ((id: string) => unknown) | null;
      if (!req) return;
      const { notify } = (req("@/lib/notify") ?? req("./notify")) as { notify: (u: string, i: unknown) => Promise<void> };
      const { prisma } = (req("@/lib/prisma") ?? req("./prisma")) as { prisma: { user: { findFirst(): Promise<{ id: string } | null> } } };
      // Platform-wide sweep: attribute to the first active user. Better than
      // dropping the announcement entirely.
      const owner = await prisma.user.findFirst();
      if (!owner) return;
      await notify(owner.id, {
        type: "success",
        title: "Cold model woke up",
        message: `${modelId} is responding now and is available in the model picker.`,
      });
    } catch {
      /* non-fatal */
    }
  })();
}

/** Probe function shape — dependency-injectable for tests. */
export type WakeProbeFn = (provider: string, modelId: string, apiKey: string, timeoutMs: number) => Promise<ProbeVerdict>;
/**
 * Re-probe every currently-cold model with progressively generous warm-up
 * timeouts. A model that ANSWERS is promoted to a fully-verified catalog
 * entry (cold flag dropped) and the catalog is re-published to the disk
 * cache so the next picker fetch shows it with no tag. A model that still
 * never answers after the full cycle stays out of the verified list (it
 * remains cold-flagged in the catalog data for observability, but the picker
 * never renders it).
 *
 * Runs entirely in the background; one cycle at a time; safe to call
 * repeatedly (concurrent kicks collapse). HTTP-error verdicts from the
 * wake probes are honest: a model 404ing under wake is genuinely dead and
 * is REMOVED from the catalog rather than kept cold.
 */
export function wakeColdModels(
  /** Injected probe (tests). Default: the real probeModel. */
  opts: {
    probe?: WakeProbeFn;
    /** Override the retry/spacing gaps (tests: 0ms). Defaults are the real pacing. */
    retryGapMs?: number;
    spacingMs?: number;
    /**
     * Called after each cold model is promoted to verified (default: durable
     * bell notification — same flow as task-completed). Tests inject a spy
     * to avoid the Prisma path. Fire-and-forget: notification failures must
     * never break the wake cycle.
     */
    onPromoted?: (modelId: string) => void;
  } = {}
): Promise<void> {
  if (wakeInFlight) return wakeInFlight;
  // Cheap rate-limit: at most one cycle per cooldown, unless forced by a
  // manual warm request.
  if (Date.now() - lastWakeAt < WAKE_COOLDOWN_MS) return Promise.resolve();
  const probeFn: WakeProbeFn = opts.probe ?? ((p, id, key, t) => probeModel(p, id, key, t));
  const onPromoted = opts.onPromoted ?? notifyWakePromotion;
  const retryGapMs = opts.retryGapMs ?? WAKE_RETRY_GAP_MS;
  const spacingMs = opts.spacingMs ?? WAKE_SPACING_MS;
  // Latency of the most recent wake probe (health telemetry on promotion).
  let lastProbeMs = 0;
  wakeInFlight = (async () => {
    lastWakeAt = Date.now();
    const data = memCache?.data ?? readDiskCache();
    if (!data) return;
    const cold = data.models.filter((m) => m.cold && !isFreshlyVerified(m)).slice(0, WAKE_MAX_MODELS);
    if (cold.length === 0) return;
    console.log(`[model-catalog] waking ${cold.length} cold model(s): ${cold.map((m) => m.id).join(", ")}`);
    wakeProgress = {
      running: true,
      startedAt: Date.now(),
      models: cold.map((m) => ({ id: m.id, state: "waking" as const, attempt: 0, totalAttempts: WAKE_ATTEMPTS })),
    };
    for (const m of cold) {
      // Per-model key lookup — cold models can theoretically span providers.
      const def = getProviderDef(m.provider);
      const key = def ? (process.env[def.keyEnvVar] || "").trim() : "";
      if (!key) {
        const st = wakeProgress.models.find((x) => x.id === m.id);
        if (st) st.state = "failed"; // no platform key for this provider
        continue;
      }
      const st = wakeProgress.models.find((x) => x.id === m.id);
      let alive = false;
      let confirmedDead = false;
      for (let attempt = 0; attempt < WAKE_ATTEMPTS && !alive; attempt++) {
        if (st) st.attempt = attempt + 1;
        const t0 = Date.now();
        const verdict = await probeFn(m.provider, m.id, key, WAKE_TIMEOUT_MS[attempt]);
        lastProbeMs = Date.now() - t0;
        if (verdict === "ok" || verdict === "rate_limited") {
          // 429 after warm-up still proves the deployment serves.
          alive = true;
        } else if (verdict === "dead") {
          confirmedDead = true;
          break; // HTTP error under generous timeout — genuinely dead
        }
        if (!alive && attempt < WAKE_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, retryGapMs));
        }
      }
      if (alive) {
        delete m.cold;
        // Promotion = a real answered probe → stamp proof of life so the
        // picker's dot goes green and the next sweep skips re-probing it.
        m.lastVerifiedAt = new Date().toISOString();
        if (Number.isFinite(lastProbeMs)) m.probeLatencyMs = lastProbeMs;
        if (st) st.state = "woke";
        console.log(`[model-catalog] woke ${m.id} — promoted to verified`);
        // Publish IMMEDIATELY. The single publish at the end of the cycle was
        // the reason a woken model stayed invisible long after its
        // "Cold model woke up" notification: a cycle covers up to
        // WAKE_MAX_MODELS × (120s + 5s + 90s + 5s + 60s) ≈ 35 minutes, and the
        // picker reads memCache (5 min TTL) or the disk cache — so a promotion
        // made at minute 2 was invisible until minute 35, and any concurrent
        // `readDiskCache()` in between re-assigned memCache to the PRE-wake
        // file, detaching the very object being mutated.
        memCache = { at: Date.now(), data };
        writeDiskCache(data);
        onPromoted(m.id);
      } else {
        if (st) st.state = confirmedDead ? "dead" : "failed";
        console.log(`[model-catalog] ${m.id} still not answering after ${WAKE_ATTEMPTS} warm-up attempts`);
      }
      await new Promise((r) => setTimeout(r, spacingMs));
    }
    // A model that 404s/400s under a GENEROUS warm-up window is not cold —
    // it is gone. Remove it from the catalog so it can never reappear via a
    // stale cache; the next sweep re-lists it only if the provider offers it
    // again (and it would then have to pass a fresh probe).
    const deadDuringWake = wakeProgress.models.filter((x) => x.state === "dead").map((x) => x.id);
    if (deadDuringWake.length > 0) {
      const deadSet = new Set(deadDuringWake);
      data.models = data.models.filter((m) => !deadSet.has(m.id));
      console.log(`[model-catalog] removed ${deadDuringWake.length} dead model(s) confirmed during wake: ${deadDuringWake.join(", ")}`);
    }
    const stillCold = data.models.filter((x) => x.cold).length;
    memCache = { at: Date.now(), data };
    writeDiskCache(data);
    wakeProgress = { ...wakeProgress, running: false };
    console.log(`[model-catalog] wake cycle done — ${stillCold} still cold`);
  })()
    .catch((err) => {
      wakeProgress = { ...wakeProgress, running: false };
      console.error("[model-catalog] wake cycle failed:", err);
    })
    .finally(() => {
      wakeInFlight = null;
    });
  return wakeInFlight;
}

/** Force a wake cycle NOW, ignoring the cooldown (manual warm button). */
export function forceWakeColdModels(
  opts: { probe?: WakeProbeFn; retryGapMs?: number; spacingMs?: number } = {}
): Promise<void> {
  lastWakeAt = 0;
  return wakeColdModels(opts);
}

/** Test hook: seed the catalog cache directly (bypasses listing/probing). */
export function seedCatalogForTests(data: CatalogResult): void {
  memCache = { at: Date.now(), data };
}

/** Test hook: read the in-memory catalog (null when never populated). */
export function getCatalogForTests(): CatalogResult | null {
  return memCache?.data ?? null;
}

/** Test hook: reset wake bookkeeping (in-flight gate, cooldown, progress). */
export function resetWakeStateForTests(): void {
  if (wakeInFlight) return; // never stomp a live cycle
  lastWakeAt = 0;
  wakeProgress = { running: false, startedAt: null, models: [] };
}

/**
 * Test hook: run the real listing+probe sweep NOW against the current cache
 * state (getVerifiedModels short-circuits on fresh caches, which hides the
 * sweep's health carry-forward from tests). Mock fetch to keep it hermetic.
 */
export function runSweepForTests(): Promise<CatalogResult> {
  return sweepCatalog();
}

/**
 * Pick the next verified model after a failure (auto-retry helper).
 *
 * @param failedModels ids that already failed this conversation (most recent first)
 * @param currentModel the model that just failed — always excluded, even when
 *   the failed list omits it (a retry never lands on the same row)
 * Everything probe-verified is eligible except the failed set — cross-provider
 * failover is the point (a dead provider's whole list is skipped by exclusion,
 * not by proximity). Ordered green (freshly verified) first, then stable
 * catalog order. Returns null when the catalog has nothing beyond the failed
 * set — the caller keeps the user's pick rather than inventing a model.
 */
export async function pickRetryModel(
  failedModels: string[],
  currentModel?: string | null
): Promise<string | null> {
  try {
    const { models } = await getVerifiedModels();
    if (models.length === 0) return null;
    // Bare-id comparison: the picker's saved key and the failure trail may
    // carry either form ("vendor/x" vs "vendor/x:free") while the catalog
    // lists only one. Exact matching would exclude the WRONG form and hand
    // back the very model that just failed.
    const bare = (s: string) => s.replace(/:free$/, "");
    const failed = new Set(failedModels.filter(Boolean).map(bare));
    if (currentModel) failed.add(bare(currentModel));
    const candidates = models.filter((m) => !failed.has(bare(m.id)));
    if (candidates.length === 0) return null;
    // Stable sort: green (freshly verified) before amber (proof of life aged
    // out), catalog order preserved within each group.
    candidates.sort((a, b) => (isFreshlyVerified(a) ? 0 : 1) - (isFreshlyVerified(b) ? 0 : 1));
    return candidates[0].id;
  } catch {
    return null;
  }
}


