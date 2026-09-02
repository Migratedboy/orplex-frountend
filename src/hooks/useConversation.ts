"use client";

import { useState, useCallback, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useConversations } from "@/components/ConversationProvider";
import { Message } from "./useMessages";

export function useConversation(setMessages: (fn: (prev: Message[]) => Message[]) => void) {
  const { data: session } = useSession();
  const { refresh } = useConversations();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [loadingConvo, setLoadingConvo] = useState(false);

  // Load a specific conversation by ID from the URL (?c=...)
  useEffect(() => {
    if (!session?.user) return;
    const params = new URLSearchParams(window.location.search);
    const convoId = params.get("c");
    if (!convoId) return; // No conversation to load — start fresh
    setLoadingConvo(true);
    fetch(`/api/conversations?id=${convoId}`)
      .then((r) => r.json())
      .then((data) => {
        const conv = data.conversation;
        if (conv) {
          setConversationId(conv.id);
          setMessages(() => conv.messages.map((m: { role: string; content: string; createdAt: string }) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
            time: new Date(m.createdAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
          })));
        }
        setLoadingConvo(false);
      })
      .catch(() => setLoadingConvo(false));
  }, [session, setMessages]);

  const saveConversation = useCallback(async (
    userContent: string,
    assistantContent: string
  ) => {
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          messages: [
            { role: "user", content: userContent },
            { role: "assistant", content: assistantContent },
          ],
        }),
      });
      const data = await res.json();
      if (data.conversationId) setConversationId(data.conversationId);
      // Refresh shared conversation cache so Sidebar + History page
      // see the new/updated conversation immediately.
      refresh();
    } catch {
      // Silent fail for persistence
    }
  }, [conversationId, refresh]);

  const newChat = useCallback(() => {
    setMessages(() => []);
    setConversationId(null);
  }, [setMessages]);

  return {
    conversationId,
    setConversationId,
    loadingConvo,
    saveConversation,
    newChat,
  };
}
