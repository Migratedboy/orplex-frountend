// src/lib/archived-chats.ts — client-side archive of conversation ids.
//
// There is no conversation-archive field in Prisma (only run-level `archived`),
// so archiving a chat is a renderer-side concept: we keep a Set of conversation
// ids in localStorage and filter them out of the Sidebar. The Archived settings
// page lists them with Restore / Delete controls.
export const ARCHIVED_KEY = "orplex.archivedChats";
export const ARCHIVED_EVENT = "orplex:archived-changed";

function readSet(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(ARCHIVED_KEY) ?? "[]");
    if (Array.isArray(raw)) return new Set(raw.filter((x) => typeof x === "string"));
  } catch {}
  return new Set();
}

function writeSet(set: Set<string>): void {
  try { localStorage.setItem(ARCHIVED_KEY, JSON.stringify([...set])); } catch {}
  window.dispatchEvent(new CustomEvent(ARCHIVED_EVENT));
}

export function getArchivedIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  return readSet();
}

export function isArchived(id: string): boolean {
  if (typeof window === "undefined") return false;
  return readSet().has(id);
}

export function archiveChat(id: string): void {
  const set = readSet();
  set.add(id);
  writeSet(set);
}

export function unarchiveChat(id: string): void {
  const set = readSet();
  set.delete(id);
  writeSet(set);
}

export function removeArchived(id: string): void {
  unarchiveChat(id);
}
