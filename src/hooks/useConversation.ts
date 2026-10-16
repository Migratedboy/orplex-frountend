"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { useConversations } from "@/components/ConversationProvider";
import { OPEN_CONVERSATION_EVENT } from "@/lib/navigation-events";
import { Message } from "./useMessages";
import { apiFetch } from "@/lib/api-base";
import { refToUrl, refsInContent } from "@/lib/client-attachments";

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
setMessages(() => conv.messages.map((m: { role: string; content: string; createdAt: string }) => {
          // Images are stored on local disk, never in the DB — the body carries
          // `attachment:<id><ext>` refs which we resolve back to local URLs so
          // a reload still renders the image instead of losing it.
          const refs = refsInContent(m.content);
          const images = refs.length
            ? refs.map((ref, i) => {
                const url = refToUrl(ref);
                return url ? { name: `image-${i + 1}`, dataUrl: url, size: 0 } : null;
              }).filter((x): x is { name: string; dataUrl: string; size: number } => x !== null)
            : undefined;
          return {
            role: m.role as "user" | "assistant",
            content: m.content,
            time: new Date(m.createdAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
            ...(images && images.length > 0 ? { images } : {}),
          };
        }));
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
    conversationIdOverride?: string | null,
    // Workspace folder (NAME) the thread belongs to — stamps new conversations
    // and refreshes existing ones so the sidebar groups threads per project.
    workspaceName?: string | null,
    /** Surfaced to the user when a save fails or truncates content. */
    onSaveError?: (message: string) => void,
  ) => {
    try {
      const targetId = conversationIdOverride !== undefined ? conversationIdOverride : conversationId;
      const res = await apiFetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: targetId,
          // Always send the CURRENT folder when one is open (threads move with
          // the workspace they continue in); omit entirely when none is open so
          // an existing tag is never wiped by a folderless save.
          ...(workspaceName ? { workspaceName } : {}),
          messages: [
            { role: "user", content: userContent },
            { role: "assistant", content: assistantContent },
          ],
        }),
      });
      const data = await res.json();
      // apiFetch does not throw on non-2xx, so a 401/500 used to resolve
      // normally with no conversationId, no error and no toast: the exchange
      // rendered fine in-session and vanished on the next reload.
      if (!res.ok) {
        onSaveError?.(`Conversation not saved (HTTP ${res.status})`);
        throw new Error(`save failed: HTTP ${res.status}`);
      }
      if (data.truncatedMessages > 0) {
        onSaveError?.(
          `${data.truncatedMessages} message(s) were too long to save in full and were truncated at 50,000 characters.`,
        );
      }
      if (data.conversationId) setConversationId(data.conversationId);
      // Refresh shared conversation cache so Sidebar + History page
      // see the new/updated conversation immediately.
      refresh();
    } catch (e) {
      // Network/abort failure - the conversation is NOT persisted, and the
      // caller must know that rather than assume the reload-recovery snapshot
      // can be discarded. Re-throw so callers can gate destructive follow-up
      // (the restore path only clears the snapshot after a confirmed save);
      // it swallowed this before, making every .catch() at the call site dead
      // code that could never observe a failure.
      onSaveError?.("Conversation not saved — the request failed.");
      throw e;
    }
  }, [conversationId, refresh]);

  const newChat = useCallback(() => {
    // Invalidate any in-flight conversation load. loadConversation guards
    // staleness with loadTokenRef, but nothing bumped it here - so clicking a
    // thread in the sidebar and then hitting New Chat before the GET resolved
    // let the response win: the "empty" new chat was repopulated with the old
    // conversation's messages and setConversationId re-attached it. The next
    // message was then appended to the thread the user had walked away from.
    loadTokenRef.current++;
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
