/**
 * conversation-tabs.ts — pure, testable helpers for the strip's conversation
 * tabs (spec §2.2): an OPEN-tab list per project, persisted in
 * `orplex.openTabs.<projectId>` (never secrets, ids only). Closing a tab
 * never deletes the chat — the id just leaves the open list.
 */

/** Sentinel id for the unsaved "New chat" state (URL "/" without ?c=). */
export const NEW_TAB_ID = "__new__";

export function openTabsKey(projectId: string): string {
  return `orplex.openTabs.${projectId}`;
}

export function loadOpenTabs(projectId: string): string[] {
  try {
    const raw = localStorage.getItem(openTabsKey(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}

export function saveOpenTabs(projectId: string, ids: string[]): void {
  try { localStorage.setItem(openTabsKey(projectId), JSON.stringify(ids)); } catch {}
}

/** Append an id (dedup). Returns the next list. */
export function withTabOpen(list: string[], id: string): string[] {
  return list.includes(id) ? list : [...list, id];
}

/** Remove an id. Returns { list, nextActive } — neighbour pick like panel-state. */
export function withTabClosed(
  list: string[],
  activeId: string | null,
  id: string
): { list: string[]; nextActive: string | null } {
  const idx = list.indexOf(id);
  const next = list.filter((t) => t !== id);
  let nextActive = activeId;
  if (activeId === id) {
    nextActive = next[Math.max(0, idx - 1)] ?? null;
  }
  return { list: next, nextActive };
}
