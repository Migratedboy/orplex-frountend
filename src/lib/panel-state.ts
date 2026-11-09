/**
 * panel-state.ts — pure, testable helpers for the Right Panel v2 tab model.
 *
 * The shell keeps `openTabs: TabId[]` + `activeTab: TabId | null`; everything
 * that touches storage, migration keys, or tab ordering lives here so it can
 * be unit-tested without React.
 *
 * Persistence contract (INVENTORY §3, DECISIONS D2):
 * - `orplex.rightPanel`      — open bool (legacy key, kept current for
 *                              AppLayout + reset-recovery-tab compatibility)
 * - `orplex.rightPanelTab`   — single legacy tab (kept current; `preview`
 *                              is the pre-v2 id of the browser tab)
 * - `orplex.rightPanelTabs`  — NEW: JSON array of open TabIds (v2 source of truth)
 */

export type TabId = "queue" | "changes" | "browser" | "terminal" | "files" | "scratch";

/** All tabs, in canonical order (reference HTML order). */
export const ALL_TABS: TabId[] = ["queue", "changes", "browser", "terminal", "files", "scratch"];

export const TAB_META: Record<
  TabId,
  { label: string; icon: string }
> = {
  queue: { label: "Queue", icon: "list" },
  changes: { label: "Changes", icon: "fork_left" },
  browser: { label: "Local browser", icon: "laptop" },
  terminal: { label: "Terminal", icon: "terminal" },
  files: { label: "Files", icon: "folder" },
  scratch: { label: "Scratch", icon: "edit_note" },
};

/** Pre-v2 id stored by older builds (and still written back for compat). */
export const LEGACY_PREVIEW_ID = "preview";

export const OPEN_KEY = "orplex.rightPanel";
export const LEGACY_TAB_KEY = "orplex.rightPanelTab";
export const OPEN_TABS_KEY = "orplex.rightPanelTabs";

function isTabId(value: unknown): value is TabId {
  return typeof value === "string" && (ALL_TABS as string[]).includes(value);
}

/**
 * Totally normalize any stored/external tab id to a v2 TabId.
 * `"preview"` (pre-v2 id) maps to `"browser"`; anything else unknown → null.
 */
export function normalizeTabId(value: unknown): TabId | null {
  if (value === LEGACY_PREVIEW_ID) return "browser";
  return isTabId(value) ? value : null;
}

/** v2 id → legacy id written back for older consumers (AppLayout, reset tab). */
export function toLegacyTabId(id: TabId): string {
  return id === "browser" ? LEGACY_PREVIEW_ID : id;
}

/**
 * Parse the new open-tabs storage value. Returns null when absent/invalid
 * (fresh install → launcher), otherwise the de-duplicated ordered list.
 * "preview" entries are migrated to "browser".
 */
export function parseOpenTabs(raw: string | null | undefined): TabId[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: TabId[] = [];
  for (const entry of parsed) {
    const id = normalizeTabId(entry);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Serialize for storage (only validated ids, canonical order preserved). */
export function serializeOpenTabs(ids: TabId[]): string {
  return JSON.stringify(ids.filter(isTabId));
}

/** One legacy stored tab (`preview` → `browser`) → a 1-element open list. */
export function legacyTabToOpenTabs(raw: string | null | undefined): TabId[] {
  const id = normalizeTabId(raw);
  return id ? [id] : [];
}

/** A programmatic default-tab request (Ctrl+T, orplex:open-panel) → open list. */
export function defaultTabToOpenTabs(tab: string | undefined): TabId[] {
  if (!tab) return [];
  const id = normalizeTabId(tab);
  return id ? [id] : [];
}

/** Add a tab if missing; it becomes active. Never duplicates. */
export function addTab(openTabs: TabId[], id: TabId): { openTabs: TabId[]; activeTab: TabId } {
  return {
    openTabs: openTabs.includes(id) ? openTabs : [...openTabs, id],
    activeTab: id,
  };
}

/**
 * Remove a tab from the open list. If it was active, activate its previous
 * neighbour (the one before it, else the next, else null).
 */
export function closeTab(
  openTabs: TabId[],
  activeTab: TabId | null,
  id: TabId
): { openTabs: TabId[]; activeTab: TabId | null } {
  const idx = openTabs.indexOf(id);
  const next = openTabs.filter((t) => t !== id);
  let nextActive = activeTab;
  if (activeTab === id) {
    nextActive = next[Math.max(0, idx - 1)] ?? null;
  }
  return { openTabs: next, activeTab: nextActive };
}

/** Closed tabs (for the "+" popover), canonical order. */
export function closedTabs(openTabs: TabId[]): TabId[] {
  return ALL_TABS.filter((t) => !openTabs.includes(t));
}
