"use client";

/**
 * useModelCatalog — the verified-model catalog engine behind the model
 * picker, extracted verbatim from ChatInput.tsx.
 *
 * Owns: the /api/models/available retry loop (fast window + settle window),
 * the P1 refetch coalescing, React-18 StrictMode cancellation handling, the
 * serverless rescue (local sweep publish), BYOK model merging, wake-promotion
 * harvesting, recents (localStorage), and the curated-defaults merge that
 * produces the final picker list.
 *
 * ChatInput keeps picker STATE (per-conversation model/effort persistence)
 * and the composer; everything catalog-related lives here. The observable
 * contract is the returned object — no component besides ChatInput consumes
 * it, and prompt-bar-model-keys.test.tsx pins the picker-side fallout.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PromptBarModel } from "@/components/PromptBar";
import { DEFAULT_MODELS as DEFAULT_MODEL_ROWS } from "@/lib/default-models";
import { listProviderDefs } from "@/lib/provider-registry";
import { apiFetch } from "@/lib/api-base";

const DEFAULT_MODELS: PromptBarModel[] = DEFAULT_MODEL_ROWS;

// Registry labels as picker tags, so a new registry provider shows up here
// with zero component changes.
const PROVIDER_TAG: Record<string, string> = Object.fromEntries(
  listProviderDefs().map((d) => [d.id, d.label])
);

const LS_RECENTS = "orplex.promptBar.recentModels";

function readRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LS_RECENTS);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

function pushRecent(key: string): string[] {
  const next = [key, ...readRecents().filter((k) => k !== key)].slice(0, 8);
  try {
    window.localStorage.setItem(LS_RECENTS, JSON.stringify(next));
  } catch {}
  return next;
}

/** Shape of the toast callback the host component supplies (useToast). */
type ToastFn = (message: string, type?: "error" | "success" | "info") => void;

export function useModelCatalog(toast: ToastFn) {
  // === Verified model catalog (fetched when the model menu opens) + recents ===
  const [catalogModels, setCatalogModels] = useState<PromptBarModel[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => readRecents());
  // Mirror for use inside loadCatalog's closure without re-creating it.
  const userModelsRef = useRef<PromptBarModel[]>([]);
  // Refs for values loadCatalog closes over. `loadCatalog` is deliberately a
  // stable useCallback([]) (it is wired to the menu-open event and must not
  // churn), so referencing toast/refreshWakePromotions directly would capture
  // the first render's values forever. React's exhaustive-deps flagged this;
  // the refs are the correct fix for "stable callback + fresh values".
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const refreshWakeRef = useRef<(() => void) | null>(null);
  const catalogInFlight = useRef(false);
  // P1: a refetch requested while a load was in flight, run once it settles.
  const catalogRefetchQueued = useRef(false);
  // Self-reference so `finish` (defined inside loadCatalog) can schedule the
  // coalesced refetch without recursing through a stale closure.
  const loadCatalogRef = useRef<(() => void) | null>(null);
  // P2: bound the cold-start retry loop by WALL-CLOCK, not attempt count.
  const catalogDeadline = useRef(0);
  const catalogSettleUntil = useRef(0);
  const CATALOG_RETRY_MS = 60_000;
  /** Quiet-polling window after the blocking indicator gives up. */
  const CATALOG_SETTLE_MS = 10 * 60_000;
  // Retry-timer + unmount guards: the catalog retry loop below can schedule
  // up to 120 × 5s retries (~10 min). Without cancellation they keep firing
  // (and setState) after unmount and waste network.
  const catalogTimers = useRef<number[]>([]);
  const catalogCancelled = useRef(false);
  useEffect(() => {
    // React 18 StrictMode (next.config.js reactStrictMode: true) mounts,
    // runs cleanup, then mounts again. This cleanup latched
    // catalogCancelled = true and nothing ever reset it, and that flag gates
    // EVERY path in loadCatalog - so after the remount the catalog fetch
    // returned immediately, finish() never ran, setCatalogLoading(false) never
    // fired, and the picker spun on "Fetching verified models…" forever,
    // pinned to the defaults. Reset on setup as well as clear on cleanup.
    catalogCancelled.current = false;
    return () => {
      catalogCancelled.current = true;
      catalogTimers.current.forEach((t) => clearTimeout(t));
      catalogTimers.current = [];
    };
  }, []);
  // BYOK models (from the user's stored keys' model listings) + the keys
  // revision marker that tells us when to refetch (new/removed keys).
  const [userModels, setUserModels] = useState<PromptBarModel[]>([]);
  const keysRevRef = useRef<string>("");
  // === Wake promotions ("Cold model woke up" bell items) ===================
  // The backend announces a woken model via a notification, but its catalog
  // re-publish can lag — the picker kept hiding the model as "cold" even
  // after telling the user it had joined. Trust the announcement as proof of
  // life: names harvested here un-hide cold models on the next fetch.
  const [wakePromoted, setWakePromoted] = useState<string[]>([]);
  const wakePromotedRef = useRef<string[]>([]);
  // STATE, not a ref (fix P3). The cold filter in the `models` getter below
  // reads these ids to decide what the picker renders. A ref mutation does not
  // schedule a render, so on the all-cold path — where nothing else writes
  // state — the updated ids were never reflected and the picker appeared to
  // ignore the fetch.
  const [coldIds, setColdIds] = useState<Set<string>>(new Set());
  // Fix 4: provider-acknowledged-but-busy models, shown after verified ones.
  const [throttledModels, setThrottledModels] = useState<PromptBarModel[]>([]);
  // True once the blocking indicator has given up but we are still polling in
  // the background. Drives a quiet one-line note instead of a spinner, so the
  // fallback trio stays usable while the real list is still landing.
  const [catalogSettling, setCatalogSettling] = useState(false);
  // Fix 5: why a configured provider is missing from the list. Surfaced as a
  // toast so "OpenRouter never appears" has an answer instead of silence.
  const [providerIssues, setProviderIssues] = useState<
    { provider: string; kind: string; detail: string }[]
  >([]);
  const issuesRef = useRef<{ provider: string; kind: string; detail: string }[]>([]);

  // A promoted model's short name matches its picker key exactly, or as the
  // provider-qualified suffix ("deepseek-v4.1-flash" ⊂ "deepseek-ai/deepseek-v4.1-flash").
  const keyMatchesPromotion = (key: string, name: string) =>
    key === name || key.split("/").pop() === name || key.endsWith("/" + name);

  // Pull recent wake notifications and record the announced model names
  // (message starts with the model's short name).
  //
  // Incremental: track the newest timestamp we have already seen and ask only
  // for what arrived since. This used to re-fetch the ENTIRE notification
  // history (since the epoch) on every catalog load — i.e. on every menu open
  // and every poll during a cold start — purely to re-derive a handful of
  // names that almost never change.
  const notificationsSinceRef = useRef<string>("1970-01-01T00:00:00.000Z");
  const refreshWakePromotions = useCallback(() => {
    const since = notificationsSinceRef.current;
    apiFetch(`/api/notifications?since=${encodeURIComponent(since)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { notifications?: { title?: string; message?: string; createdAt?: string }[] }) => {
        const fresh = j.notifications ?? [];
        // Advance the watermark with whatever the newest item is, so the next
        // call is a true delta.
        const newest = fresh.reduce<string>(
          (acc, n) => (n.createdAt && n.createdAt > acc ? n.createdAt : acc),
          since
        );
        notificationsSinceRef.current = newest;
        const names = fresh
          .filter((n) => n.title === "Cold model woke up" && n.message)
          .map((n) => n.message!.split(" ")[0].toLowerCase());
        if (names.length === 0) return;
        const merged = Array.from(new Set([...wakePromotedRef.current, ...names]));
        if (merged.length !== wakePromotedRef.current.length) {
          wakePromotedRef.current = merged;
          setWakePromoted(merged);
        }
      })
      .catch(() => {});
  }, []);

  const loadCatalog = useCallback(() => {
    // P1 — COALESCE, don't drop. This used to `return` outright while a load
    // was in flight, which meant reopening the model menu (and the
    // orplex:wake-promoted event) did literally NOTHING for the whole retry
    // window — up to ~10 minutes. A menu opened during a cold poll is exactly
    // the moment the user most wants fresh data, so queue exactly one
    // refetch to run when the in-flight load settles.
    if (catalogInFlight.current) {
      catalogRefetchQueued.current = true;
      return;
    }
    catalogInFlight.current = true;
    catalogDeadline.current = Date.now() + CATALOG_RETRY_MS;
    catalogSettleUntil.current = Date.now() + CATALOG_SETTLE_MS;
    setCatalogLoading(true);
    // Harvest wake promotions in parallel (see wakePromoted above).
    refreshWakeRef.current?.();

    // SERVERLESS RESCUE. The cloud backend cannot run a sweep: caches are
    // memory + disk only, a serverless cold start has neither, and the
    // minutes-long background sweep is killed with the request. Its
    // /api/models/available therefore answers empty FOREVER while this app —
    // a long-lived local process — runs a real sweep at boot. When the cloud
    // answers empty (or stale), this helper reads THIS machine's own sweep
    // result (?local=1 keeps the proxy from forwarding), renders it
    // immediately, and publishes it to /api/models/ingest so every later cold
    // start gets the catalog back. Publishing is monotonic on probedAt, so a
    // once-published newer list can't be rolled back by any client.
    type RawAvailable = {
      success?: boolean;
      models?: { id: string; name: string; provider: string; contextWindow?: number; free?: boolean; cold?: boolean }[];
      throttledModels?: { id: string; name: string; provider: string; contextWindow?: number; free?: boolean }[];
      coldModelIds?: string[];
      health?: Record<string, { health?: "green" | "amber"; lastVerifiedAt?: string; probeLatencyMs?: number }>;
      probedAt?: string;
      providers?: string[];
      providerIssues?: { provider: string; kind: string; detail: string; count: number }[];
      userModels?: { id: string; name: string; provider: string; contextWindow?: number; free?: boolean }[];
      keysRev?: string;
    };
    const mapAvailable = (raw: { id: string; name: string; provider: string; contextWindow?: number; free?: boolean }, withHealth: boolean, health: Record<string, { health?: "green" | "amber"; lastVerifiedAt?: string; probeLatencyMs?: number }>) => ({
      key: raw.id,
      name: raw.name || raw.id,
      tag: PROVIDER_TAG[raw.provider] || raw.provider,
      ...(withHealth
        ? {
            healthDot: health[raw.id]?.health ?? "amber",
            healthTitle: health[raw.id]?.lastVerifiedAt
              ? `Last verified ${new Date(health[raw.id].lastVerifiedAt!).toLocaleString()}${
                  health[raw.id]?.probeLatencyMs ? ` · probe ${(health[raw.id].probeLatencyMs! / 1000).toFixed(1)}s` : ""
                }`
              : undefined,
          }
        : {}),
      detail:
        [raw.free ? "free" : undefined, raw.contextWindow ? `${Math.round(raw.contextWindow / 1024)}k` : undefined]
          .filter(Boolean)
          .join(" · ") || undefined,
    });
    const rescueFromServerless = (cloudLooksEmpty: boolean, cloudProbedMs: number) => {
      if (catalogCancelled.current) return;
      apiFetch("/api/models/available?local=1")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((local: RawAvailable) => {
          if (catalogCancelled.current) return;
          const localModels = (local.models ?? []).filter((m) => m.id);
          if (localModels.length === 0) return;
          const localColdSet = new Set(local.coldModelIds ?? []);
          const localVisibleCount = localModels.filter(
            (m) => !localColdSet.has(m.id)
          ).length;
          const localProbedMs = Date.parse(local.probedAt ?? "") || 0;
          const newerThanCloud = localProbedMs > cloudProbedMs;
          // Publish when the local sweep has something the cloud snapshot lacks:
          // the cloud is empty, or this sweep is strictly newer (wake
          // promotions / a fresh boot sweep land on the NEXT poll).
          if (cloudLooksEmpty || newerThanCloud) {
            apiFetch("/api/models/ingest", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                models: localModels,
                throttledModels: local.throttledModels ?? [],
                providerIssues: local.providerIssues ?? [],
                probedAt: local.probedAt,
                providers: local.providers ?? [],
              }),
            }).catch(() => {});
          }
          if (!cloudLooksEmpty) return; // display stays on the (working) cloud list
          if (localVisibleCount === 0 && (local.throttledModels ?? []).length === 0) return;
          const localList = localModels.map((m) => mapAvailable(m, true, local.health ?? {}));
          const localThrottled = (local.throttledModels ?? []).map((m) => mapAvailable(m, false, {}));
          setColdIds((prev) => new Set([...prev, ...localColdSet]));
          setCatalogModels(localList);
          setThrottledModels(localThrottled);
          setCatalogSettling(false);
          setCatalogLoading(false);
        })
        .catch(() => {});
    };
    const finish = () => {
      catalogInFlight.current = false;
      setCatalogLoading(false);
      // P1: drain the coalesced refetch exactly once.
      if (catalogRefetchQueued.current && !catalogCancelled.current) {
        catalogRefetchQueued.current = false;
        window.setTimeout(() => loadCatalogRef.current?.(), 0);
      }
    };
    const laterWith = (fn: () => void, ms: number) => {
      if (catalogCancelled.current) return;
      // Track the handle so it can be cancelled on unmount, but DROP it from the
      // list once it fires — the array was only ever pruned wholesale on unmount,
      // so every menu open during a cold catalog added ~12 entries that were
      // never reclaimed for the life of the view.
      const handle = window.setTimeout(() => {
        catalogTimers.current = catalogTimers.current.filter((t) => t !== handle);
        if (!catalogCancelled.current) fn();
      }, ms);
      catalogTimers.current.push(handle);
    };
    const later = (fn: () => void) => laterWith(fn, 5000);
    // Quiet phase: same bookkeeping, slower cadence, no network noise.
    const laterSlow = (fn: () => void) => laterWith(fn, 15_000);
    const tryFetch = (attempt: number) => {
      if (catalogCancelled.current) return;
      apiFetch("/api/models/available")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j: {
          success?: boolean;
          models?: { id: string; name: string; provider: string; contextWindow?: number; free?: boolean }[];
          health?: Record<string, { health?: "green" | "amber"; lastVerifiedAt?: string; probeLatencyMs?: number }>;
          coldModelIds?: string[];
          /** Provider acknowledged these serve but is busy (429) — fix 4. */
          throttledModels?: { id: string; name: string; provider: string; contextWindow?: number; free?: boolean }[];
          userModels?: { id: string; name: string; provider: string; contextWindow?: number; free?: boolean }[];
          keysRev?: string;
          /** Configured providers that contributed 0 models, and why (fix 5). */
          providerIssues?: { provider: string; kind: string; detail: string; count: number }[];
          probedAt?: string;
        }) => {
          // Picker contract: ONLY models proven to answer are rendered.
          //  - throttledModels are never sent by the picker endpoint anymore
          //    (they never replied to a probe — the old "throttled" tag rows
          //    were exactly the dead-feeling picks being reported);
          //  - cold models (probe timed out on NVIDIA build.farm warm-up) are
          //    hidden here and woken by the background engine — once a wake
          //    probe answers, the model lands here WITHOUT the cold flag and
          //    appears on the next fetch.
          const coldSet = new Set(j.coldModelIds ?? []);
          // P3: state, not a ref — a ref write does not re-render, so the
          // cold filter in the `models` getter never saw these ids.
          setColdIds(coldSet);
          const health = j.health ?? {};
          // Cold models are KEPT in the stored list — the hide happens in the
          // `models` getter below, so a wake promotion un-hides instantly
          // without waiting for the backend's catalog re-publish.
          const list = (j.models ?? [])
            .map((m) => ({
              key: m.id,
              name: m.name || m.id,
              tag: PROVIDER_TAG[m.provider] || m.provider,
              // Probe health dot: green = answered <24h ago; amber = proof of
              // life has aged out. Latency (when known) rides in the tooltip.
              healthDot: health[m.id]?.health ?? "amber",
              healthTitle: health[m.id]?.lastVerifiedAt
                ? `Last verified ${new Date(health[m.id].lastVerifiedAt!).toLocaleString()}${
                    health[m.id].probeLatencyMs ? ` · probe ${(health[m.id].probeLatencyMs! / 1000).toFixed(1)}s` : ""
                  }`
                : undefined,
              detail: [
                m.free ? "free" : undefined,
                m.contextWindow ? `${Math.round(m.contextWindow / 1024)}k` : undefined,
              ]
                .filter(Boolean)
                .join(" · ") || undefined,
            }));
          const userList = (j.userModels ?? []).map((m) => ({
            key: m.id,
            name: m.name || m.id,
            tag: PROVIDER_TAG[m.provider] || m.provider,
            detail: ["🔑", m.free ? "free" : undefined, m.contextWindow ? `${Math.round(m.contextWindow / 1024)}k` : undefined]
              .filter(Boolean)
              .join(" "),
          }));
          // Fix 4: throttled models (provider answered 429 => it ACKNOWLEDGES
          // the model serves, it is merely busy) used to never be sent by the
          // endpoint, which is why OpenRouter — configured and working —
          // contributed zero rows. Render them after the verified list, tagged
          // "busy", so they are selectable but never mistaken for confirmed.
          const throttledList = (j.throttledModels ?? []).map((m) => ({
            key: m.id,
            name: m.name || m.id,
            tag: PROVIDER_TAG[m.provider] || m.provider,
            detail: ["busy", m.contextWindow ? `${Math.round(m.contextWindow / 1024)}k` : undefined]
              .filter(Boolean)
              .join(" · "),
          }));
          // Fix 5: tell the user WHY a configured provider is missing, once
          // per distinct cause (never on every poll).
          const issues = j.providerIssues ?? [];
          const issueSig = issues.map((i) => `${i.provider}:${i.kind}`).join("|");
          if (issueSig && issueSig !== issuesRef.current.map((i) => `${i.provider}:${i.kind}`).join("|")) {
            issuesRef.current = issues;
            setProviderIssues(issues);
            const label = (k: string) =>
              k === "invalid_key" ? "API key rejected"
              : k === "no_credits" ? "out of credits"
              : k === "network" ? "unreachable"
              : k;
            toastRef.current(
              issues.map((i) => `${i.provider}: ${label(i.kind)}`).join(" · "),
              "error"
            );
          }
          // New/changed keys invalidate the memo → merge the fresh BYOK list.
          const rev = j.keysRev ?? "";
          if (rev !== keysRevRef.current || userList.length !== userModelsRef.current.length) {
            keysRevRef.current = rev;
            setUserModels(userList);
            userModelsRef.current = userList;
          }
          // Retry only while NOTHING is visible: the catalog is empty or every
          // entry is cold. A throttled model counts as visible.
          const visibleCount = list.filter((m) => !coldSet.has(m.key)).length;
          if (visibleCount > 0 || throttledList.length > 0) {
            setCatalogModels(list);
            setThrottledModels(throttledList);
            // A serverless snapshot may still have REMAINING CATCH-UP to do if
            // this machine locally swept later than its last publish — push the
            // newer result without touching display (the next poll converges).
            rescueFromServerless(false, Date.parse(j.probedAt ?? "") || 0);
            setCatalogSettling(false);
            finish();
            return;
          }
          // Cloud has nothing visible: serverless probably lost its sweep.
          rescueFromServerless(true, Date.parse(j.probedAt ?? "") || 0);
          // The server answers instantly but returns an empty list while its
          // probe sweep runs in the background. A full sweep is MINUTES
          // (hundreds of live completion probes), so this is two phases:
          //
          //   1. FAST WINDOW (CATALOG_RETRY_MS) — poll every 5s with the
          //      "Fetching verified models…" indicator up. A warm catalog
          //      answers immediately and never reaches this.
          //   2. SETTLE WINDOW (CATALOG_SETTLE_MS) — keep polling every 15s
          //      but STOP showing the blocking indicator, so the fallback trio
          //      stays visible and the real list swaps in the moment it lands.
          //
          // Previously phase 1 was 60s and then polling stopped dead: the sweep
          // is far slower than that, so the picker sat on the fallback trio
          // with no spinner and no way to refresh but reopening the menu.
          if (catalogCancelled.current) { finish(); return; }
          const now = Date.now();
          if (now < catalogDeadline.current) {
            // Kick the sweep ONCE, not on every 5s poll. The endpoint already
            // schedules a repair via after(); re-POSTing each round was ~12
            // redundant requests per cold start and could restart the very
            // sweep we are waiting on.
            if (attempt === 0) apiFetch("/api/models/warm", { method: "POST" }).catch(() => {});
            later(() => tryFetch(attempt + 1));
            return;
          }
          if (now < catalogSettleUntil.current) {
            setCatalogModels(list);
            setThrottledModels(throttledList);
            // Indicator off, keep polling quietly.
            setCatalogLoading(false);
            setCatalogSettling(true);
            catalogInFlight.current = true;
            laterSlow(() => tryFetch(attempt + 1));
            return;
          }
          // Both windows elapsed — settle on what we have.
          setCatalogModels(list);
          setThrottledModels(throttledList);
          finish();
        })
        .catch(() => {
          if (catalogCancelled.current) { finish(); return; }
          // Network/auth hiccup: retry inside the fast window, then quietly
          // through the settle window, then give up.
          const now = Date.now();
          if (now < catalogDeadline.current) {
            later(() => tryFetch(attempt + 1));
            return;
          }
          if (now < catalogSettleUntil.current) {
            setCatalogLoading(false);
            setCatalogSettling(true);
            catalogInFlight.current = true;
            laterSlow(() => tryFetch(attempt + 1));
            return;
          }
          finish();
        });
    };
    tryFetch(0);
  }, [CATALOG_SETTLE_MS]);
  // Keep a stable handle to the latest loadCatalog so `finish` can schedule the
  // coalesced P1 refetch without re-creating the callback's deps.
  useEffect(() => {
    loadCatalogRef.current = loadCatalog;
  }, [loadCatalog]);
  useEffect(() => {
    refreshWakeRef.current = refreshWakePromotions;
  }, [refreshWakePromotions]);

  // A fresh wake toast means a model just became usable — refresh promotions
  // + catalog so it appears in the picker without reopening the menu.
  useEffect(() => {
    const onWake = () => {
      refreshWakeRef.current?.();
      loadCatalog();
    };
    window.addEventListener("orplex:wake-promoted", onWake);
    return () => window.removeEventListener("orplex:wake-promoted", onWake);
  }, [refreshWakePromotions, loadCatalog]);

  // Verified models first, then provider-acknowledged-but-busy ones (fix 4),
  // then the BYOK models the user can reach with their own keys — deduped by id
  // (a BYOK listing proves the same id the platform catalog verified, so keep
  // the verified row's tag).
  //
  // P5: memoized. As a bare IIFE this produced a NEW array identity on every
  // render, which defeated PromptBar's `filtered` useMemo (deps: models,
  // recentModels), re-ran its cursor/scroll effects on every render, and reset
  // the keyboard cursor to row 0 each time the menu opened.
  const models = useMemo<PromptBarModel[]>(() => {
    const visible = (m: PromptBarModel) =>
      !coldIds.has(m.key) || wakePromoted.some((n) => keyMatchesPromotion(m.key, n));
    const catalog = catalogModels.filter(visible);
    const busy = throttledModels.filter(visible);
    const verified = catalog.length > 0 ? catalog : busy;
    const pool = verified.length === 0 && busy.length > 0 ? busy : verified;

    // The curated defaults are a PERMANENT group, not a fallback. They used to
    // appear only when the catalog came back empty, so a probe that found
    // anything made them vanish - the menu silently dropped from 14 models to
    // whatever the platform happened to have verified. They are now always
    // listed first under their own "Default Models" header.
    //
    // Dedup is by key, and a catalog/BYOK row WINS over the default row of the
    // same id, because it carries real probe data (health dot, latency) - except
    // that its `group` is dropped, since the default header is the more useful
    // placement for a curated entry.
    const out: PromptBarModel[] = [];
    const seen = new Set<string>();
    for (const m of DEFAULT_MODELS) {
      // The curated list is deduped too - a duplicate id here renders two rows
      // with the SAME React key, which React reports as a console error.
      if (seen.has(m.key)) continue;
      out.push(m);
      seen.add(m.key);
    }
    for (const m of [...pool, ...busy, ...userModels]) {
      if (seen.has(m.key)) {
        // Upgrade the default row in place with live probe data.
        const i = out.findIndex((d) => d.key === m.key);
        if (i !== -1) {
          out[i] = { ...out[i], ...m, group: out[i].group };
          continue;
        }
        continue;
      }
      seen.add(m.key);
      out.push(m);
    }
    return out;
  }, [catalogModels, coldIds, throttledModels, userModels, wakePromoted]);

  /**
   * BYOK bypass.
   *
   * The user's own keys are LISTING-PROVEN: the Settings "Fetch models"
   * engine already reached the provider with that key and recorded what it
   * serves. The platform catalog additionally live-probes every model, which
   * takes minutes and can legitimately return nothing. Gating the user's own
   * models behind that sweep made the picker appear empty for a long time even
   * though usable models were available the whole time.
   *
   * So: BYOK models count as "we have something to show". The blocking spinner
   * only appears when there is genuinely nothing to list.
   */
  // The curated defaults are always listed, so `models` is never empty. What we
  // actually need to know is whether a LIVE source (platform catalog or the
  // user's own keys) has produced anything yet. The old
  // `models !== FALLBACK_MODELS` identity check was written when the defaults
  // were the only thing the fallback returned; it is now permanently true, which
  // silently disabled the blocking spinner for every case it was meant to cover.
  const hasLiveModels = catalogModels.length > 0 || throttledModels.length > 0 || userModels.length > 0;
  const showBlockingSpinner = catalogLoading && !hasLiveModels && models.length === 0;

  return {
    /** The final picker list: curated defaults + verified + busy + BYOK. */
    models,
    recents,
    setRecents,
    catalogLoading,
    catalogSettling,
    providerIssues,
    hasLiveModels,
    showBlockingSpinner,
    loadCatalog,
    refreshWakePromotions,
  };
}

export { pushRecent };
