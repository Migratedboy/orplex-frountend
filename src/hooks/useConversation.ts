"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { useConversations } from "@/components/ConversationProvider";
import { OPEN_CONVERSATION_EVENT } from "@/lib/navigation-events";
import { Message } from "./useMessages";
import { apiFetch } from "@/lib/api-base";

export function useConversation(setMessages: (fn: (prev: Message[]) => Message[]) => void) {
  const { data: session } = useSession();
  const { refresh } = useConversations();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [loadingConvo, setLoadingConvo] = useState(false);
  // Guards against a slow response for an OLD conversation overwriting the
  // messages of a newer one when the user clicks through chats quickly.
  const loadTokenRef = useRef(0);

  const loadConversation = useCallback((convoId: string | null) => {
    if (!session?.user?.id || !convoId) return;
    const token = ++loadTokenRef.current;
    setLoadingConvo(true);
    apiFetch(`/api/conversations?id=${encodeURIComponent(convoId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (token !== loadTokenRef.current) return; // superseded — drop stale
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
      .catch(() => {
        if (token === loadTokenRef.current) setLoadingConvo(false);
      });
  }, [session?.user?.id, setMessages]);

  // Load a specific conversation by ID from the URL (?c=...). Runs on mount
  // (direct links / full page loads) AND reacts to later navigations, because
  // opening a conversation from the Sidebar / TopBar / History does a
  // client-side router.push that never remounts '/' and never fires popstate.
  // Without the event + popstate listeners, clicking a conversation while on
  // the chat page changed the URL but never loaded its messages.
  useEffect(() => {
    if (!session?.user) return;

    const fromUrl = () => {
      const convoId = new URLSearchParams(window.location.search).get("c");
      loadConversation(convoId);
    };
    const onOpenConversation = (e: Event) => {
      const detail = (e as CustomEvent<{ id?: string }>).detail;
      loadConversation(detail?.id ?? new URLSearchParams(window.location.search).get("c"));
    };

    fromUrl(); // direct link / first paint
    window.addEventListener("popstate", fromUrl);
    window.addEventListener(OPEN_CONVERSATION_EVENT, onOpenConversation);
    return () => {
      window.removeEventListener("popstate", fromUrl);
      window.removeEventListener(OPEN_CONVERSATION_EVENT, onOpenConversation);
    };
  }, [session, loadConversation]);

  const saveConversation = useCallback(async (
    userContent: string,
    assistantContent: string,
    conversationIdOverride?: string | null
  ) => {
    try {
      const targetId = conversationIdOverride !== undefined ? conversationIdOverride : conversationId;
      const res = await apiFetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: targetId,
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
