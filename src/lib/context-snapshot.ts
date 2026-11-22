/**
 * context-snapshot.ts — what the composer is holding, in one read-only shape.
 *
 * The context ring lives in the toolbar (inside PromptBar) but its inputs are
 * owned by the chat surface (transcript) and the file processor (attachments).
 * Rather than drilling five props through the composer, the owner publishes a
 * snapshot here and the ring subscribes with useSyncExternalStore. Publishing
 * is cheap and idempotent: identical snapshots don't notify.
 */

export interface ContextSnapshotMessage {
  role: string;
  content: string;
}

export interface ContextSnapshotFile {
  name?: string;
  chars: number;
}

export interface ContextSnapshot {
  conversationId: string | null;
  messages: ContextSnapshotMessage[];
  model: string | null;
  mode: string;
  effort?: string;
  /** Files the composer is holding (attachments). */
  files: ContextSnapshotFile[];
  /** @-mentioned project paths in the draft. */
  mentions: ContextSnapshotFile[];
  /** Newest message length — cheap change-detection signal, not for display. */
  lastMessageChars?: number;
}

const EMPTY: ContextSnapshot = {
  conversationId: null,
  messages: [],
  model: null,
  mode: "code",
  files: [],
  mentions: [],
};

let current: ContextSnapshot = EMPTY;
const listeners = new Set<() => void>();

function signature(s: ContextSnapshot): string {
  return [
    s.conversationId ?? "",
    s.messages.length,
    s.messages.reduce((n, m) => n + m.content.length, 0),
    s.lastMessageChars,
    s.model ?? "",
    s.mode,
    s.effort ?? "",
    s.files.map((f) => `${f.name ?? ""}:${f.chars}`).join(","),
    s.mentions.map((f) => `${f.name ?? ""}:${f.chars}`).join(","),
  ].join("|");
}

export function publishContextSnapshot(patch: Partial<ContextSnapshot>): void {
  const next: ContextSnapshot = { ...current, ...patch };
  next.lastMessageChars = next.messages.length ? next.messages[next.messages.length - 1].content.length : 0;
  if (signature(next) === signature(current)) return;
  current = next;
  for (const l of listeners) l();
}

export function getContextSnapshot(): ContextSnapshot {
  return current;
}

export function subscribeContextSnapshot(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam. */
export function resetContextSnapshot(): void {
  current = EMPTY;
  for (const l of listeners) l();
}
