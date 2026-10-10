"use client";

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { useSession } from "next-auth/react";

import { apiFetch } from "@/lib/api-base";
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
      const res = await apiFetch("/api/conversations", { signal });
      if (signal?.aborted) return;
      if (!res.ok) {
        setLoading(false); // keep last good list, but never spin forever
        return;
      }
      const data = await res.json();
      if (signal?.aborted) return;
      if (data.conversations) setConversations(data.conversations);
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
    // Optimistic update — update local state immediately, then fire server request.
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title } : c))
    );
    try {
      // NOTE: apiFetch only throws on network failure — HTTP 4xx/5xx must be
      // checked explicitly or the optimistic update wrongly persists.
      const res = await apiFetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) fetchConversations(); // revert on rejection
    } catch {
      // Revert on failure
      fetchConversations();
    }
  }, [fetchConversations]);

  const deleteConversation = useCallback(async (id: string) => {
    // Optimistic update — remove from local state immediately.
    setConversations((prev) => prev.filter((c) => c.id !== id));
    try {
      const res = await apiFetch(`/api/conversations/${id}`, { method: "DELETE" });
      if (!res.ok) fetchConversations(); // revert on rejection
    } catch {
      // Revert on failure
      fetchConversations();
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
