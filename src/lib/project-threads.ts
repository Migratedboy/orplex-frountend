// project-threads.ts — Pure grouping/filtering for the sidebar's Projects
// section. Extracted so the node Jest suite can pin the rules: which threads
// belong to which project row, ordering, the per-row cap, and what the
// "Load threads" link should point at. No React, no browser APIs.

export interface ThreadLike {
  id: string;
  title: string;
  updatedAt: string;
  workspaceName?: string | null;
}

/** Display label: alias when set, else the folder name; Ungrouped fallback. */
export function projectLabel(name: string | null | undefined, displayName?: string | null): string {
  if (!name) return "Ungrouped";
  return (displayName && displayName.trim()) || name;
}

/**
 * Threads for one project row: tagged with this workspace, newest first
 * (updatedAt desc — the API list is already newest-first, this makes the
 * helper standalone), capped at `limit` (default 5).
 */
export function threadsForProject(threads: ThreadLike[], name: string, limit = 5): ThreadLike[] {
  return threads
    .filter((t) => t.workspaceName === name)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit);
}

/** Threads with no workspace tag (the Ungrouped row). */
export function ungroupedThreads(threads: ThreadLike[], limit = 5): ThreadLike[] {
  return threads
    .filter((t) => !t.workspaceName)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit);
}

/** Whether the History page should show this thread for a ?workspace= filter. */
export function matchesWorkspaceFilter(
  thread: ThreadLike,
  workspace: string | null
): boolean {
  if (!workspace) return true;
  if (workspace === "__ungrouped__") return !thread.workspaceName;
  return thread.workspaceName === workspace;
}

/** Build the "Load threads" href for a project (or Ungrouped). */
export function historyLinkFor(name: string | null): string {
  return !name ? "/history?workspace=__ungrouped__" : `/history?workspace=${encodeURIComponent(name)}`;
}

/** Read the ?workspace= query value the History page honors. */
export function workspaceFromQuery(query: string): string | null {
  const value = new URLSearchParams(query).get("workspace");
  return value && value.trim() ? value : null;
}
