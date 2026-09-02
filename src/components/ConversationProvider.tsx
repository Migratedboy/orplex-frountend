"use client";

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { useSession } from "next-auth/react";

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
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

  const fetchConversations = useCallback(() => {
    if (!session?.user?.id) return;
    setLoading(true);
    fetch("/api/conversations")
      .then((r) => r.json())
      .then((data) => {
        if (data.conversations) setConversations(data.conversations);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [session?.user?.id]);

  // Fetch on mount, when session changes, and every 30s for background updates
  useEffect(() => {
    fetchConversations();
    const interval = setInterval(fetchConversations, 30000);
    return () => clearInterval(interval);
  }, [fetchConversations]);

  const renameConversation = useCallback(async (id: string, title: string) => {
    // Optimistic update — update local state immediately, then fire server request.
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title } : c))
    );
    try {
      await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
    } catch {
      // Revert on failure
      fetchConversations();
    }
  }, [fetchConversations]);

  const deleteConversation = useCallback(async (id: string) => {
    // Optimistic update — remove from local state immediately.
    setConversations((prev) => prev.filter((c) => c.id !== id));
    try {
      await fetch(`/api/conversations/${id}`, { method: "DELETE" });
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
