"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "./Toast";
import PromptBar, { type PromptBarMode, type PromptBarModel, type PromptBarSource } from "./PromptBar";
import { useFileProcessor, formatFileSize, getFileIcon } from "@/hooks/useFileProcessor";
import { SKILL_CATEGORIES, type Skill } from "@/lib/skills";
import ConnectorsPanel from "./ConnectorsPanel";
import { IconMcp } from "./Icons";
import type { AttachedFile } from "@/hooks/useFileProcessor";
import { Attachment01Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import QuotaIndicator from "./QuotaIndicator";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import { QuickActions } from "./ui";
import type { AgentMode } from "./ModeSelector";
import { listProviderDefs } from "@/lib/provider-registry";

import { apiFetch } from "@/lib/api-base";
interface ChatInputProps {
  onSend: (text: string, fullContent: string, textFiles: any[], imageFiles: any[], mode: AgentMode, effort?: string, model?: string) => void;
  onStop: () => void;
  loading: boolean;
  agentRunning: boolean;
  isStreaming?: boolean;
  agentMode: AgentMode;
  onModeChange: (mode: AgentMode) => void;
  onFastAnswer?: (userMessage: string) => void;
  lastUserMessage?: string;
  queue?: { id: string; text: string; addedAt: number; model?: string }[];
  onQueueAdd?: (text: string, fullContent: string, textFiles: any[], imageFiles: any[], mode: AgentMode, model?: string, effort?: string) => void;
  onQueueRemove?: (id: string) => void;
  onQueueClear?: () => void;
  /** Active conversation id — scopes picker persistence per chat */
  conversationId?: string | null;
  /** Models that failed in THIS conversation (most recent first) — arms the one-shot auto-retry swap. */
  failedModels?: string[];
  /** Clears the failure trail after the composer consumed it (one-shot). */
  clearFailedModels?: () => void;
  /** Re-arms the picker with the swapped model (persists per conversation). */
  onRetryModelSwap?: (nextModelId: string, failedModelIds: string[]) => void;
  /** True after the user pressed Stop — the composer acknowledges it without
   *  blocking the next send (the input stays live). */
  stopped?: boolean;
}

/**
 * Static, hoisted to module scope. These were inline JSX expressions, so a
 * fresh array of ~100 command objects and a fresh efforts array were built on
 * EVERY ChatInput render. `commands` is a dependency of PromptBar's `filtered`
 * memo, which feeds `list`, which feeds the scroll-into-view layout effect —
 * so the model menu scrolled on every parent render while open.
 */
const SKILL_COMMANDS = SKILL_CATEGORIES.flatMap((c) =>
  c.skills.map((s) => ({ key: s.id, name: `/${s.name}`, description: s.description, insert: s.promptPrefix }))
);
const EFFORT_TIERS = ["Low", "Medium", "High"];

const MODES: (PromptBarMode & { agentMode: AgentMode })[] = [
  { key: "ask", name: "Ask", description: "Simple chat, no file access", agentMode: "ask" },
  { key: "plan", name: "Plan", description: "Analyze codebase, create plan", agentMode: "plan" },
  { key: "code", name: "Code", description: "Edit files, run commands", agentMode: "code" },
];

// Fallback trio shown only if the live catalog can't be fetched. Tagged
// "checking" — NOT verified: these ride the server's failover chain rather
// than a passed probe, and a throttled free tier can leave them silent.
// Honesty beats a pretty picker: once the catalog lands these are replaced.
const FALLBACK_MODELS: PromptBarModel[] = [
  { key: "openai/gpt-oss-120b", name: "GPT-OSS 120B", tag: "Groq", detail: "checking availability…" },
  { key: "qwen/qwen3.8-27b", name: "Qwen 3.8 27B", tag: "Groq", detail: "checking availability…" },
  { key: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron Super", tag: "OpenRouter", detail: "checking availability…" },
];

// Registry labels as picker tags, so a new registry provider shows up here
// with zero component changes.
const PROVIDER_TAG: Record<string, string> = Object.fromEntries(
  listProviderDefs().map((d) => [d.id, d.label])
);

// Verified-catalog + recents state (module scope shared hook below).
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

const SOURCES: PromptBarSource[] = [
  { key: "files", name: "Files", description: "Upload from this device", icon: Attachment01Icon, attach: true },
  { key: "skills", name: "Skills", description: "100+ prebuilt prompt templates", icon: SparklesIcon, insert: "/" },
  { key: "mcp", name: "MCP servers", description: "Connect Supabase, Vercel, Figma, GitHub…", icon: <IconMcp size={16} />, attach: true },
];

const PLACEHOLDERS: Record<AgentMode, string> = {
  ask: "Ask anything…",
  plan: "Describe what to analyze or plan…",
  code: "Describe what you want to build or fix…",
};

const QUICK_ACTION_PROMPTS: Record<string, string> = {
  "fix-bugs": "Fix bugs in the current project",
  "add-tests": "Add tests for the current project",
  optimize: "Optimize the current project",
  export: "Export the project as a .zip",
  regenerate: "Regenerate the last response",
};

// --- Picker persistence -----------------------------------------------------
// Global last-used model/effort (survives reloads) + a per-conversation map
// (switching chats restores that chat's last-used level). Stored in
// localStorage — the composer is browser-local state.
const LS_LAST = "orplex.promptBar.last";
const LS_PER_CONVO = "orplex.promptBar.perConvo";

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export interface PickerState {
  modelKey?: string;
  effort?: string;
}

function loadPickers(conversationId: string | null | undefined): PickerState {
  if (conversationId) {
    const perConvo = readJSON<Record<string, PickerState>>(LS_PER_CONVO, {});
    const saved = perConvo[conversationId];
    if (saved) return saved;
  }
  return readJSON<PickerState>(LS_LAST, {});
}

function savePickers(conversationId: string | null | undefined, state: PickerState) {
  writeJSON(LS_LAST, state);
  if (conversationId) {
    const perConvo = readJSON<Record<string, PickerState>>(LS_PER_CONVO, {});
    perConvo[conversationId] = state;
    // Keep the map bounded — 50 most recent conversations.
    const keys = Object.keys(perConvo);
    if (keys.length > 50) {
      delete perConvo[keys[0]];
    }
    writeJSON(LS_PER_CONVO, perConvo);
  }
}

/**
 * Imperative bridge for files attached OUTSIDE the composer (drag-and-drop
 * onto the page). The composer owns its attachment list internally, so the
 * page-level drop zone has no other way in — same pattern as the artifact and
 * memory panel bridges in AppLayout.
 */
export const droppedFilesBridge: { add: ((files: AttachedFile[]) => void) | null } = { add: null };

export default function ChatInput({ onSend, onStop, loading, agentRunning, isStreaming = false, agentMode, onModeChange, onFastAnswer, lastUserMessage, queue = [], onQueueAdd, onQueueRemove, onQueueClear, conversationId, failedModels, clearFailedModels, onRetryModelSwap, stopped = false }: ChatInputProps) {
  const files = useFileProcessor();
  // Publish the attach bridge (page-level drag-and-drop) and release it on unmount.
  useEffect(() => {
    droppedFilesBridge.add = files.addFiles;
    return () => {
      droppedFilesBridge.add = null;
    };
  }, [files.addFiles]);
  const [busy, setBusy] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const clearRef = useRef<(() => void) | null>(null);
  const controlsRef = useRef<{ clear: () => void; setText: (t: string) => void } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // === Verified model catalog (fetched when the model menu opens) + recents ===
  const [catalogModels, setCatalogModels] = useState<PromptBarModel[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => readRecents());
  // Mirror for use inside loadCatalog's closure without re-creating it.
  const userModelsRef = useRef<PromptBarModel[]>([]);
  const { toast } = useToast();
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
    // pinned to FALLBACK_MODELS. Reset on setup as well as clear on cleanup.
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
          if (list.some((m) => !coldSet.has(m.key)) || throttledList.length > 0) {
            setCatalogModels(list);
            setThrottledModels(throttledList);
            setCatalogSettling(false);
            finish();
            return;
          }
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
  }, []);
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
    if (pool.length === 0) return userModels.length > 0 ? userModels : FALLBACK_MODELS;
    const seen = new Set(pool.map((m) => m.key));
    return [...pool, ...busy.filter((m) => !seen.has(m.key) && seen.add(m.key)),
      ...userModels.filter((m) => !seen.has(m.key) && seen.add(m.key))];
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
  const hasReadyModels = models.length > 0 && models !== FALLBACK_MODELS;
  const showBlockingSpinner = catalogLoading && !hasReadyModels;
  const recentModels: PromptBarModel[] = useMemo(
    () => recents.map((key) => models.find((m) => m.key === key)).filter((m): m is PromptBarModel => !!m),
    [recents, models]
  );

  // Restored picker state — recomputed when the conversation changes so each
  // chat gets its own last-used model/effort (falling back to the global
  // last-used values).
  const [pickerState, setPickerState] = useState<PickerState>(() => loadPickers(conversationId));
  useEffect(() => {
    setPickerState(loadPickers(conversationId));
  }, [conversationId]);

  const isWorking = loading || agentRunning || busy;

  const handleSkillSelected = useCallback((skill: Skill) => {
    const prefix = `${skill.promptPrefix}\n\n`;
    controlsRef.current?.setText(prefix);
  }, []);

  // Archives carry no inline text — inlining them produced an empty code
  // fence. They are still passed through so the send path can persist them
  // locally and hand the model a real path for extract_archive.
  const inlineBlocks = (textFiles: AttachedFile[]) =>
    textFiles
      .filter((f) => f.type !== "archive")
      .map(
        (f) =>
          `\n\n---\n**File: \`${f.name}\`** (${formatFileSize(f.size)})\n\`\`\`\n${f.content}\n\`\`\``
      )
      .join("");

  const emit = (msg: string, textFiles: AttachedFile[], imageFiles: { name: string; dataUrl: string; size: number }[], mode: AgentMode, effort?: string, model?: string) => {
    const contentWithFiles = msg + inlineBlocks(textFiles);
    onSend(msg, contentWithFiles, textFiles, imageFiles, mode, effort, model);
  };

  const buildContent = (draft: string, textFiles: AttachedFile[]) => {
    if (textFiles.length === 0) return draft;
    return draft + inlineBlocks(textFiles);
  };

  // === One-shot auto-retry model swap ===================================
  // A failed conversation carries its failed-model ids (useChatSession
  // records them per conversation, most recent first). The swap arms only
  // when the model about to be sent IS the one that failed (bare-id match:
  // "vendor/x" ≡ "vendor/x:free") — a model the user deliberately re-picked
  // is never overridden. It fires ONCE: the trail is cleared immediately,
  // and any later failure re-arms it with that model. With no catalog
  // (offline / still sweeping) the swap silently doesn't happen; the
  // server's sibling-id failover still applies.
  const pendingFailed = failedModels ?? [];
  const consumeFailure = useRef(false);
  const bareKey = (s: string) => s.replace(/:free$/, "");
  if (pendingFailed.length > 0) {
    const armed = pickerState.modelKey;
    consumeFailure.current = !!armed && bareKey(armed) === bareKey(pendingFailed[0]);
  }
  const swapForRetry = async (picked: PromptBarModel | undefined): Promise<PromptBarModel | undefined> => {
    if (!consumeFailure.current || pendingFailed.length === 0) return picked;
    consumeFailure.current = false;
    clearFailedModels?.();
    const currentKey = picked?.key ?? pickerState.modelKey;
    try {
      const { pickRetryModel } = await import("@/lib/model-catalog");
      const nextId = await pickRetryModel(pendingFailed, currentKey);
      if (!nextId) return picked; // nothing verified beyond the failed set — keep the pick
      const next = models.find((m) => m.key === nextId);
      if (!next) return picked;
      // Re-arm the picker + persist per conversation so the WHOLE task runs
      // on the replacement (a mid-run provider swap isn't possible).
      setPickerState({ ...pickerState, modelKey: next.key });
      savePickers(conversationId, { ...pickerState, modelKey: next.key });
      setRecents(pushRecent(next.key));
      onRetryModelSwap?.(next.key, pendingFailed);
      return next;
    } catch {
      return picked;
    }
  };

  const metaToSend = async (text: string, meta: { mode?: PromptBarMode; effort?: string; model?: PromptBarModel }) => {
    const msg = text.trim();
    const textFiles = files.getTextFiles();
    const imageFiles = files.getImageFiles().map((f) => ({ name: f.name, dataUrl: f.dataUrl!, size: f.size }));
    if (!msg && textFiles.length === 0 && imageFiles.length === 0) return;
    const mode: AgentMode = (MODES.find((m) => m.key === meta.mode?.key)?.agentMode ?? agentMode);
    // Clear BEFORE the await. swapForRetry can await a dynamic import of
    // model-catalog (hundreds of ms on a cold chunk, seconds on first load
    // after boot) and nothing disables the attach button, the file input or the
    // paste listener meanwhile — so anything attached in that window was
    // dropped by clearFiles() after the send had already snapshotted the file
    // list, and the chip vanished with no indication it had ever been added.
    files.clearFiles();
    const model = await swapForRetry(meta.model);
    emit(msg, textFiles, imageFiles, mode, meta.effort?.toLowerCase(), model?.key);
    clearRef.current?.();
  };

  const handleQueue = () => {
    if (!onQueueAdd) return;
    const draft = (document.querySelector<HTMLTextAreaElement>(".prompt-bar__input")?.value ?? "").trim();
    const textFiles = files.getTextFiles();
    const imageFiles = files.getImageFiles().map((f) => ({ name: f.name, dataUrl: f.dataUrl!, size: f.size }));
    if (!draft && !files.hasFiles) return;

    // Effort rides along so the replayed prompt runs at the level the user
    // picked (it used to be silently dropped on dequeue).
    onQueueAdd(draft, buildContent(draft, textFiles), textFiles, imageFiles, agentMode, pickerState.modelKey, pickerState.effort);
    files.clearFiles();
    clearRef.current?.();
  };

  // Model picks made in the TopBar model switcher land here — keep the
  // composer's picker (and its per-conversation persistence) in sync.
  useEffect(() => {
    const onModelChanged = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (!id || pickerState.modelKey === id) return;
      const next = { ...pickerState, modelKey: id };
      setPickerState(next);
      savePickers(conversationId, next);
      setRecents(pushRecent(id));
    };
    window.addEventListener("orplex:model-changed", onModelChanged);
    return () => window.removeEventListener("orplex:model-changed", onModelChanged);
  }, [pickerState, conversationId]);

  // Skills → insert prompt prefix into the bar (dispatched by legacy popups)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<Skill>).detail;
      if (detail) handleSkillSelected(detail);
    };
    window.addEventListener("orplex:skill-selected", handler);
    return () => window.removeEventListener("orplex:skill-selected", handler);
  }, [handleSkillSelected]);

  // Image paste → attach as image chip (text pastes flow inline into the bar)
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (!file) continue;
        e.preventDefault();
        // Same 10MB ceiling the attach button enforces via MAX_IMAGE_SIZE.
        // Paste bypassed it entirely, so pasting a huge screenshot built a
        // multi-megabyte data URL in memory and shipped it straight to the
        // provider, where it is rejected as an oversized request.
        const { MAX_IMAGE_SIZE } = await import("@/lib/file-utils");
        if (file.size > MAX_IMAGE_SIZE) {
          toastRef.current(`That image is too large (max ${formatFileSize(MAX_IMAGE_SIZE)})`, "error");
          return;
        }
        const { readFileAsDataUrl } = await import("@/lib/file-utils");
        try {
          const dataUrl = await readFileAsDataUrl(file);
          const ext = file.type.split("/")[1] || "png";
          files.addFiles([
            { name: `pasted-image.${ext}`, content: "", size: file.size, type: "image", dataUrl },
          ]);
        } catch {
          toastRef.current("Could not read the pasted image", "error");
        }
        return;
        }
      }
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [files]);

  // The composer floats over the message list, so the list's bottom padding,
  // the run cards' clearance, and the empty-state hero all reserve the bar's
  // height via --composer-h. Publish the measured height (and keep it in sync
  // as chips, the queue, or extra input lines grow the bar) so that clearance
  // is exact rather than a guess.
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const root = document.documentElement;
    const apply = () => root.style.setProperty("--composer-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--composer-h");
    };
  }, []);

  return (
    <>
    <div className="chat-input-bar" ref={barRef}>
      <div className="chat-input-inner">
        <div className="ws-switcher-row">
          <WorkspaceSwitcher />
          <button
            type="button"
            className="mcp-chip"
            aria-label="MCP connectors"
            title="MCP connectors — Supabase, Vercel, Figma, GitHub…"
            onClick={() => setMcpOpen(true)}
          >
            <IconMcp size={14} />
            <span className="mcp-chip-label">MCP</span>
          </button>
        </div>
        {files.hasFiles && (
          <div className="file-chips">
            {files.attachedFiles.map((f, i) => (
              <div key={i} className={`file-chip ${f.type === "image" ? "file-chip-image" : ""} ${f.name.startsWith("pasted-") ? "file-chip-pasted" : ""}`}>
                {f.type === "image" && f.dataUrl ? (
                  <img src={f.dataUrl} alt={f.name} className="file-chip-thumb" />
                ) : (
                  <span className="file-chip-icon">{getFileIcon(f.name)}</span>
                )}
                <div className="file-chip-info">
                  <span className="file-chip-name">{f.name}</span>
                  {f.name.startsWith("pasted-") && f.content ? (
                    <span className="file-chip-preview">{f.content.slice(0, 80)}{f.content.length > 80 ? "…" : ""}</span>
                  ) : (
                    <span className="file-chip-size">({formatFileSize(f.size)})</span>
                  )}
                </div>
                <button onClick={() => files.removeFile(i)} className="file-chip-remove">&times;</button>
              </div>
            ))}
          </div>
        )}
        <QuickActions
          onAction={(action) => {
            controlsRef.current?.setText(QUICK_ACTION_PROMPTS[action] ?? action);
            document.querySelector<HTMLTextAreaElement>(".prompt-bar__input")?.focus();
          }}
          hasFiles={files.hasFiles}
          isRunning={isWorking}
        />
        <div className="chat-input-wrapper prompt-bar-wrapper">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={async (e) => {
              const fileList = e.target.files;
              if (!fileList || fileList.length === 0) return;
      const { processFileListDetailed } = await import("@/lib/file-utils");
      const { picked, rejected } = await processFileListDetailed(fileList);
      if (picked.length > 0) files.addFiles(picked);
      // Never swallow a refusal: a file that vanished with no message is what
      // made "the AI ignores my files" look like a model problem.
      for (const r of rejected) {
        toastRef.current(`Skipped ${r.name} — ${r.reason}`, "error");
      }
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          />
          {isWorking && onQueueAdd && (
            <button className="chat-queue-btn" title="Queue this prompt" aria-label="Queue next prompt" onClick={handleQueue}>
              <span style={{ fontSize: 11, fontWeight: 600 }}>Q</span>
            </button>
          )}
          <PromptBar
            placeholder={PLACEHOLDERS[agentMode]}
            modes={MODES}
            defaultMode={agentMode}
            sources={SOURCES}
            commands={SKILL_COMMANDS}
            models={models}
            recentModels={recentModels}
            modelsLoading={showBlockingSpinner}
        modelsSettling={catalogLoading && !showBlockingSpinner}
            onModelMenuOpened={loadCatalog}
            defaultModel={pickerState.modelKey ?? models[0].key}
            efforts={EFFORT_TIERS}
            defaultEffort={pickerState.effort
              ? pickerState.effort.charAt(0).toUpperCase() + pickerState.effort.slice(1)
              : "Medium"}
            onModelChange={(m) => {
              const next = { ...pickerState, modelKey: m.key };
              setPickerState(next);
              savePickers(conversationId, next);
              setRecents(pushRecent(m.key));
              window.dispatchEvent(new CustomEvent("orplex:model-changed", { detail: m.key }));
            }}
            onEffortChange={(level) => {
              const next = { ...pickerState, effort: level.toLowerCase() };
              setPickerState(next);
              savePickers(conversationId, next);
            }}
            busy={isWorking}
            onSend={metaToSend}
            onModeChange={(m) => {
              const am = MODES.find((x) => x.key === m.key)?.agentMode;
              if (am) onModeChange(am);
            }}
            onStop={() => { onStop(); setBusy(false); }}
            onAttach={(source) => {
              if (source.key === "mcp") {
                setMcpOpen(true);
                return;
              }
              fileInputRef.current?.click();
            }}
            onRegisterClear={(fn) => { clearRef.current = fn; }}
            onRegisterControls={(c) => { controlsRef.current = c; }}
            className="prompt-bar--chat"
          />
        </div>
        {stopped && !isWorking && (
          <div className="chat-stop-note" role="status">
            <span className="ms ms-sm" aria-hidden="true">stop_circle</span>
            <span>Stopped</span>
            <span className="chat-stop-note-hint">Send again to continue</span>
          </div>
        )}
        {queue.length > 0 && (
          <div className="queue-indicator">
            <div className="queue-header">
              <span className="queue-count"><span className="ms ms-sm">format_list_bulleted</span> Queue ({queue.length})</span>
              <button className="queue-clear-btn" onClick={onQueueClear}>Clear all</button>
            </div>
            <div className="queue-list">
              {queue.map((item, i) => (
                <div key={item.id} className="queue-item">
                  <span className="queue-item-drag" title="Drag to reorder">⋮⋮</span>
                  <span className="queue-item-num">{i + 1}</span>
                  <div className="queue-item-content">
                    <span className="queue-item-text">{item.text.slice(0, 60)}{item.text.length > 60 ? "…" : ""}</span>
                    <span className="queue-item-meta">
                      {item.text.length} chars • added {new Date(item.addedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                  <button className="queue-item-remove" onClick={() => onQueueRemove?.(item.id)} title="Remove from queue">×</button>
                </div>
              ))}
            </div>
          </div>
        )}
        <QuotaIndicator />
        <p className="chat-disclaimer">Orplex Agent can make mistakes. Verify important information.</p>
        {onFastAnswer && lastUserMessage && isStreaming && (
          <div className="fast-answer-bar">
            <button
              className="fast-answer-btn"
              onClick={() => onFastAnswer(lastUserMessage)}
              title="Get a quick answer from a faster model"
            >
              <span>Answer Now</span>
              <span className="fast-answer-hint">— quick reply from a faster model</span>
            </button>
          </div>
        )}
      </div>
    </div>
    {/* The connectors dialog is a fixed, full-screen overlay. The bar now
        carries a backdrop-filter, which would make the bar the containing
        block for that overlay (clamping it to the composer) — so it renders
        as a sibling of the bar instead. Same tree depth for the rest of the
        app, and the bar's filtered box never contains a fixed layer. */}
    <ConnectorsPanel open={mcpOpen} onClose={() => setMcpOpen(false)} />
    </>
  );
}
