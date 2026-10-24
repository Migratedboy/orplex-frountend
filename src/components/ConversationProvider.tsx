"use client";

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { useSession } from "next-auth/react";

import {
  listConversations,
  renameConversation as renameConversationRemote,
  deleteConversation as deleteConversationRemote,
  isLocalConversationMode,
  type ConversationSummary,
} from "@/lib/conversations-transport";

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Workspace folder (NAME) the thread was created in; null = Ungrouped. */
  workspaceName?: string | null;
  messages: { content: string }[];
}

interface ConversationContextType {
  conversations: Conversation[];
  loading: boolean;
  /** Optimistically rename a conversation (update cache + server) */
  renameConversation: (id: string, title: string) => Promise<void>;
  /** Optimistically delete a conversation (update cache + server) */
  deleteConversation: (id: string) => Promise<void>;
  /** Re-fetch conversations from the server */
  refresh: () => void;
}

const ConversationContext = createContext<ConversationContextType>({
  conversations: [],
  loading: true,
  renameConversation: async () => {},
  deleteConversation: async () => {},
  refresh: () => {},
});

export function useConversations() {
  return useContext(ConversationContext);
}

const MIGRATED_FLAG = "orplex.conversations-migrated";
let migrationInFlight = false;

/**
 * One-time cloud → local import (desktop only). Runs when the local store
 * answered an EMPTY list and the migration flag is not set: asks the local
 * migration route to pull every cloud thread (full messages) into the
 * on-device store. Cloud rows are never deleted — they stay as a backup.
 * A failed import leaves the flag unset so the next session retries; the
 * store-side import is additive and skips ids that already exist, so retries
 * can't duplicate rows. Returns the imported count (0 when nothing was
 * needed), or null when a migration attempt was skipped/failed.
 */
async function maybeImportFromCloud(): Promise<number | null> {
  if (migrationInFlight) return null;
  migrationInFlight = true;
  try {
    if (localStorage.getItem(MIGRATED_FLAG)) return null;
    const res = await fetch("/api/conversations/migrate-from-cloud", { method: "POST" });
    // The route may legitimately report "nothing to import" (signed-out or
    // zero cloud threads) — either way the attempt ran and must not repeat.
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as {
      importedCount?: number;
      conversations?: unknown[];
    };
    // Hand the pulled threads to the on-device store (the route itself runs
    // in the Next server and cannot touch the Electron main process). The
    // import is additive and skips existing ids, so retries never duplicate.
    const list = Array.isArray(data.conversations) ? data.conversations : [];
    const bridge = window.orplexDesktop?.conversations;
    if (!bridge) return null;
    const outcome = await bridge.import(list);
    await bridge.flush();
    // Only mark done after the rows actually reached the store.
    localStorage.setItem(MIGRATED_FLAG, "1");
    return typeof outcome.imported === "number"
      ? outcome.imported
      : typeof data.importedCount === "number"
      ? data.importedCount
      : 0;
  } catch {
    // Network/infra failure — retried on a later refresh.
    return null;
  } finally {
    migrationInFlight = false;
  }
}

export function ConversationProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchConversations = useCallback(async (signal?: AbortSignal) => {
    if (!session?.user?.id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const rows: ConversationSummary[] = await listConversations(signal);
      if (signal?.aborted) return;
      setConversations(rows);
      // The early return above guarantees a signed-in user here.
      if (isLocalConversationMode()) {
        const imported = await maybeImportFromCloud();
        // Imported rows appear immediately instead of waiting for the next
        // 30s poll. Re-entry is flag-guarded and cannot recurse.
        if (imported !== null && imported > 0) {
          const after: ConversationSummary[] = await listConversations(signal);
          if (!signal?.aborted && after.length > 0) setConversations(after);
        }
      }
    } catch {
      // Keep last good state on network failure.
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [session?.user?.id]);

  // Fetch on mount, when session changes, and every 30s for background updates.
  // Aborted on unmount/session change so a slow list can't overwrite fresh
  // state; overlapping polls are skipped so responses can't land out of order.
  useEffect(() => {
    const ctrl = new AbortController();
    let busy = false;
    const tick = () => {
      if (ctrl.signal.aborted || busy) return;
      busy = true;
      void fetchConversations(ctrl.signal).finally(() => { busy = false; });
    };
    tick();
    const interval = setInterval(tick, 30000);
    return () => { clearInterval(interval); ctrl.abort(); };
  }, [fetchConversations]);

  const renameConversation = useCallback(async (id: string, title: string) => {
    // Optimistic update — update local state immediately, then persist below.
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title } : c))
    );
    try {
      // Either transport only rejects when the rename truly failed — a silent
      // optimistic update must not survive a failed write.
      await renameConversationRemote(id, title);
    } catch {
      fetchConversations(); // revert on rejection
    }
  }, [fetchConversations]);

  const deleteConversation = useCallback(async (id: string) => {
    // Optimistic update — remove from local state immediately.
    setConversations((prev) => prev.filter((c) => c.id !== id));
    try {
      await deleteConversationRemote(id);
    } catch {
      fetchConversations(); // revert on rejection
    }
  }, [fetchConversations]);

  return (
    <ConversationContext.Provider
      value={{
        conversations,
        loading,
        renameConversation,
        deleteConversation,
        refresh: fetchConversations,
      }}
    >
      {children}
    </ConversationContext.Provider>
  );
}
