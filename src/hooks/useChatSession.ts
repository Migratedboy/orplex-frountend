"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMessages, Message } from "./useMessages";
import { useConversation } from "./useConversation";
import { AttachedFile } from "./useFileProcessor";
import { AgentMode } from "@/components/ModeSelector";
import { useToast } from "@/components/Toast";
import { useFileSystemContext } from "@/components/FileSystemProvider";
import { FileNode } from "./useFileSystem";
import { buildWorkspaceContext } from "@/lib/client-signatures";
import { listFilesUnderPath, parseToolCalls, replaceLastStatus } from "@/lib/tool-text";
import { subscribeBackgroundChat, abortCurrentTask, readTaskSnapshot, clearTaskSnapshot, getCurrentTask, type BackgroundTask } from "@/lib/background-chat";
import { normalizeThinkingBlocks } from "@/lib/stream-reader";
import { stampFailedMessage, findFailedExchange, userTypedText } from "@/lib/message-retry";
import { formatFileSize } from "@/lib/file-utils";
import { useSession } from "next-auth/react";
// Lazy-load background-worker — it's the heaviest module chain
// Only imported when actually sending a message, not on page load
const loadBackgroundWorker = () => import("@/lib/background-worker");
import { useRouter } from "next/navigation";

// ─── Helpers ────────────────────────────────────────────────────────────────
// (listFilesUnderPath, parseToolCalls and replaceLastStatus moved to
// @/lib/tool-text — the single shared home for these helpers.)

/** Safely extract error message string from any error type */
function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return "Unknown error"; }
}

// ─── Status Icons ────────────────────────────────────────────────────────────

const STATUS = {
  thinking: "thinking…",
  reading: (path: string) => `analysing [${path}]`,
  listing: (path: string) => `analysing [${path || "."}]`,
  writing: (path: string) => `writing [${path}]`,
  analyzing: (path: string) => `analysing [${path}]`,
  done: "done",
};

// ─── Hook ────────────────────────────────────────────────────────────────────

const MAX_TOOL_TURNS = 6;

export interface QueuedPrompt {
  id: string;
  text: string;
  fullContent: string;
  textFiles: AttachedFile[];
  imageFiles: { name: string; dataUrl: string; size: number }[];
  mode: AgentMode;
  /** Reasoning effort from the prompt bar (low/medium/high) — replayed on dequeue. */
  effort?: string;
  addedAt: number;
  /** Model id picked in the prompt bar (optional — queueing drops it) */
  model?: string;
}

export function useChatSession() {
  const { toast } = useToast();
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const { data: session } = useSession();
  const msg = useMessages();
  const convo = useConversation(msg.setMessages);
  // Live ref for the subscriber: reflects conversation switches (history
  // loads, New Chat) without re-subscribing.
  const convoIdRef = useRef<string | null>(convo.conversationId);
  const { directoryName, fileContents, fileTree, readFile, writeFile, editFile } = useFileSystemContext();
  const [agentStatus, setAgentStatus] = useState<string>("");
  const [bgTask, setBgTask] = useState<BackgroundTask | null>(null);
  const [thinking, setThinking] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [queue, setQueue] = useState<QueuedPrompt[]>([]);
  const queueRef = useRef<QueuedPrompt[]>([]);
  const thinkingRef = useRef(false);
  // === Auto-retry after a model failure ===================================
  // When a task fails, the model it ran on is recorded HERE (per conversation,
  // most recent first). The composer consumes the list ONCE: on the next
  // send it swaps the failed model for the next probe-verified model
  // (pickRetryModel) and clears the entry. Cleared on success, Stop, and
  // new task — a working conversation never carries a stale failure.
  const [failedModels, setFailedModels] = useState<Record<string, string[]>>({});
  const failedModelsRef = useRef<Record<string, string[]>>({});

  // Keep refs in sync
  useEffect(() => { queueRef.current = queue; }, [queue]);
  useEffect(() => { thinkingRef.current = thinking; }, [thinking]);
  useEffect(() => { failedModelsRef.current = failedModels; }, [failedModels]);
  convoIdRef.current = convo.conversationId; // render-time sync — always current
  useEffect(() => { convoIdRef.current = convo.conversationId; }, [convo.conversationId]);

  // Safety timeout — force-clear thinking after 120s to prevent stuck state
  useEffect(() => {
    if (!thinking) return;
    const timeout = setTimeout(() => {
      setThinking(false);
      setAgentStatus("");
    }, 120000);
    return () => clearTimeout(timeout);
  }, [thinking]);

  // Subscribe to background task updates — with auto-dequeue
  useEffect(() => {
    return subscribeBackgroundChat((task) => {
      // Only set bgTask to active tasks — terminal/done/error/cancelled/null clears it
      const isActive = task && (task.status === "streaming" || task.status === "tool_executing" || task.status === "awaiting_approval");
      const isStreaming = task && (task.status === "streaming" || task.status === "tool_executing");
      setBgTask(isActive ? task : null);
      setStreaming(!!isStreaming);

      if (!isActive) {
        setThinking(false);
        setAgentStatus("");

        // The user may have navigated to a DIFFERENT conversation while this
        // background task was running. Never write into the store or save a
        // conversation that isn't the one currently on screen — the message
        // store holds the active conversation's bubbles.
        const isCurrentConvo = !task || task.conversationId === convoIdRef.current;

        // CRITICAL: Write final content back to the assistant message that
        // belongs to THIS task. Searching backward for the task's own user
        // message means a stale task completing after a newer send can never
        // clobber the newer message's placeholder.
        if (isCurrentConvo && task && (task.status === "done" || task.status === "error") && task.displayContent) {
          // Last-line-of-defense: reasoning must never bleed into the main
          // answer text. Markers are NORMALIZED, not stripped — the ThinkingCard
          // (collapsible reasoning) stays in the saved message; only malformed
          // wrappers that would render reasoning as plain text get repaired.
          const finalText = normalizeThinkingBlocks(task.displayContent);
          msgRef.current.setMessages(prev => {
            if (prev.length === 0) return prev;
            const updated = [...prev];
            for (let i = updated.length - 2; i >= 0; i--) {
              if (updated[i].role === "user" && updated[i].content === task.userMessage) {
                const assistantIdx = i + 1;
                if (
                  assistantIdx < updated.length &&
                  updated[assistantIdx].role === "assistant" &&
                  !updated[assistantIdx].content
                ) {
                  updated[assistantIdx] = { ...updated[assistantIdx], content: finalText };
                }
                return updated;
              }
            }
            // Fallback (no matching user message): only touch the very last
            // message if it's still an empty assistant placeholder.
            const last = updated[updated.length - 1];
            if (last.role === "assistant" && !last.content) {
              updated[updated.length - 1] = { ...last, content: finalText };
            }
            return updated;
          });
        }

        // Save conversation to DB when task completes — only if the task
        // belongs to the conversation currently being viewed.
        if (isCurrentConvo && task && task.status === "done" && task.displayContent) {
          const userMsg = task.userMessage || "";
          const assistantMsg = normalizeThinkingBlocks(task.displayContent);
          if (userMsg && assistantMsg) {
            convoRef.current.saveConversation(userMsg, assistantMsg, undefined, directoryNameRef.current).catch(() => {});
          }
        }

        // A FAILED task (model died mid-response, all providers down, notice
        // stream from the server) must still land in the bubble: write the
        // partial/notice content into this task's own assistant placeholder.
        // Without this the user sees an empty bubble with a dead spinner —
        // the exact "no response and no idea why" failure being fixed.
        // The bubble is STAMPED with [FAILED] (+ original send meta) so the
        // renderer can offer one-click Retry on the exchange.
        if (isCurrentConvo && task && task.status === "error" && !task.aborted && task.displayContent) {
          const finalText = normalizeThinkingBlocks(task.displayContent);
          msgRef.current.setMessages(prev => {
            if (prev.length === 0) return prev;
            const updated = [...prev];
            for (let i = updated.length - 2; i >= 0; i--) {
              if (updated[i].role === "user" && updated[i].content === task.userMessage) {
                const assistantIdx = i + 1;
                if (
                  assistantIdx < updated.length &&
                  updated[assistantIdx].role === "assistant" &&
                  !updated[assistantIdx].content
                ) {
                  updated[assistantIdx] = {
                    ...updated[assistantIdx],
                    content: stampFailedMessage(finalText, {
                      mode: task.mode,
                      model: task.model,
                    }),
                  };
                }
                return updated;
              }
            }
            return updated;
          });
        }

        // Record / clear model failures for the auto-retry. Only REAL model
        // failures count (not user Stops, not cancellations); any later
        // success, stop, or new task wipes the trail so a healthy
        // conversation never swaps the user's model without cause.
        if (task && (task.status === "done" || task.status === "error" || !task)) {
          const convoKey = task?.conversationId ?? convoIdRef.current ?? "";
          if (task?.status === "error" && !task.aborted && task.model) {
            setFailedModels(prev => {
              const list = prev[convoKey] ?? [];
              if (list[0] === task.model) return prev; // already recorded
              return { ...prev, [convoKey]: [task.model!, ...list].slice(0, 4) };
            });
          } else if (convoKey && failedModelsRef.current[convoKey]) {
            setFailedModels(prev => {
              if (!(convoKey in prev)) return prev;
              const next = { ...prev };
              delete next[convoKey];
              return next;
            });
          }
        }

        // Auto-dequeue: send the next prompt if one is queued — but NOT when
        // the task was aborted (user pressed Stop / New Chat). Stopping means
        // stop; the next queued prompt fires only after a natural finish.
        const q = queueRef.current;
        if (q.length > 0 && task && !task.aborted && (task.status === "done" || task.status === "error")) {
          const next = q[0];
          setQueue(prev => prev.slice(1));
          setTimeout(() => {
            sendMessageRef.current(next.text, next.fullContent, next.textFiles, next.imageFiles, next.mode, next.effort, next.model);
          }, 300);
        }
      }
    });
  }, []);

  // Listen for New Chat event from sidebar
  useEffect(() => {
    const handler = () => {
      convoRef.current.newChat();
      msgRef.current.clearMessages();
      setAgentStatus("");
      setBgTask(null);
      setThinking(false);
      setStreaming(false);
      // Navigate to / if not already there — use Next.js router for instant client-side nav
      if (window.location.pathname !== "/") {
        router.push("/");
      }
    };
    window.addEventListener("orplex:new-chat", handler);
    return () => window.removeEventListener("orplex:new-chat", handler);
  }, []);

  // Stable refs
  const msgRef = useRef(msg);
  const convoRef = useRef(convo);
  const toastRef = useRef(toast);
  const fileContentsRef = useRef(fileContents);
  const fileTreeRef = useRef(fileTree);
  const readFileRef = useRef(readFile);
  const writeFileRef = useRef(writeFile);
  const editFileRef = useRef(editFile);
  const directoryNameRef = useRef(directoryName);

  msgRef.current = msg;
  convoRef.current = convo;
  toastRef.current = toast;
  fileContentsRef.current = fileContents;
  fileTreeRef.current = fileTree;
  readFileRef.current = readFile;
  writeFileRef.current = writeFile;
  editFileRef.current = editFile;
  directoryNameRef.current = directoryName;

  // === Reload recovery: restore a task that was interrupted by a page reload ===
  // The worker loop dies with the tab, so an in-flight task can't resume. But
  // its partial state was snapshotted to sessionStorage (see background-chat).
  // Once the app has loaded, rebuild the visible exchange as an explicitly
  // "interrupted" pair in the conversation it belonged to — nothing is lost,
  // and the user can send a follow-up to continue.
  const restoreAttemptedRef = useRef(false);
  const convoLoadObservedRef = useRef(false);
  useEffect(() => {
    if (convo.loadingConvo) convoLoadObservedRef.current = true;
  }, [convo.loadingConvo]);

  useEffect(() => {
    if (restoreAttemptedRef.current) return;
    if (!session?.user?.id) return;

    const hasCParam = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("c");

    // When the URL points at a conversation, its history loads asynchronously
    // (useConversation). Wait until that load has started AND finished so our
    // restored bubbles are appended after the loaded history, not clobbered by
    // it. A fresh chat (no ?c) has nothing to load — restore immediately.
    const convoIdMissing = convo.conversationId === null;
    if (hasCParam && convoIdMissing && !convoLoadObservedRef.current) return;
    if (hasCParam && convoIdMissing && convo.loadingConvo) return;

    const snap = readTaskSnapshot();
    if (!snap) return;
    restoreAttemptedRef.current = true;

    // Only in-flight tasks are restored — terminal ones are already written
    // back + saved through the subscriber path.
    if (snap.status === "done" || snap.status === "error") {
      clearTaskSnapshot();
      return;
    }

    // If a task is already running on this fresh page (the user sent a new
    // message before this effect ran), any stored snapshot belongs to that new
    // task — restore must not duplicate it.
    if (getCurrentTask() !== null) {
      clearTaskSnapshot();
      return;
    }

    // The snapshot belongs to a different conversation than the one on screen
    // → drop it rather than inject into the wrong thread.
    const activeConvoId = convo.conversationId;
    if (activeConvoId && snap.conversationId && activeConvoId !== snap.conversationId) {
      clearTaskSnapshot();
      return;
    }

    const m = msgRef.current;
    const t = toastRef.current;
    const c = convoRef.current;
    const userText = snap.userMessage || "(restored prompt)";
    // Restore the reasoning UI too: normalize (not strip) so an unclosed
    // [THINKING] block from the snapshot renders as the ThinkingCard, not raw text.
    const partial = snap.displayContent?.trim() ? normalizeThinkingBlocks(snap.displayContent) : "";
    // [INTERRUPTED] marker renders as a dedicated styled banner in
    // MessageContent (see parseContent) instead of an inline italic line.
    const assistantText = partial
      ? `${partial}\n[INTERRUPTED]`
      : "[INTERRUPTED]";

    // Rebuild the exchange. Guard against a duplicate when the last user
    // message is already this task's prompt (e.g. partial history overlap).
    m.setMessages(prev => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (!(last?.role === "user" && last.content === userText)) {
        updated.push({ role: "user", content: userText, time: m.now() });
      }
      updated.push({ role: "assistant", content: assistantText, time: m.now() });
      return updated;
    });

    // Re-attach to the interrupted conversation (or create one if the chat had
    // never been saved yet). Persist the restored pair so another reload won't
    // lose it again.
    if (snap.conversationId && !activeConvoId) {
      c.setConversationId(snap.conversationId);
    }
    c.saveConversation(userText, assistantText, snap.conversationId || undefined, directoryNameRef.current).catch(() => {});

    t("Your previous task was interrupted by the reload — partial output restored.", "info");
    clearTaskSnapshot();
  }, [session?.user?.id, convo.loadingConvo, convo.conversationId]);

  const sendMessageInner = useCallback(async (
    text: string,
    fullContent: string,
    textFiles: AttachedFile[],
    imageFiles: { name: string; dataUrl: string; size: number }[],
    mode: AgentMode = "ask",
    effort?: string,
    model?: string
  ) => {
    const m = msgRef.current;
    const c = convoRef.current;
    const t = toastRef.current;
    const localContents = fileContentsRef.current;
    const localTree = fileTreeRef.current;
    const readLocalFile = readFileRef.current;
    const writeLocalFile = writeFileRef.current;
    const editLocalFile = editFileRef.current;
    const activeDirName = directoryNameRef.current;

    // ── Build workspace context ───────────────────────────────────────────
    // Antigravity approach: send AST signatures (compact), not full file contents.
    // The AI uses read_file tool calls to load full files on-demand.
    let contentWithFiles = fullContent;

    if (activeDirName && localTree.length > 0) {
      // Pass fullContent (typed text + attached/pasted file content) so the
      // workspace context wraps around it instead of replacing it.
      const { context } = buildWorkspaceContext(
        localTree,
        localContents,
        fullContent,
        activeDirName
      );
      contentWithFiles = context;
    }

    const userMsg: Message = {
      role: "user",
      content: text || (textFiles.length > 0 ? `Uploaded ${textFiles.length} file(s)` : `Uploaded ${imageFiles.length} image(s)`),
      time: m.now(),
      files: textFiles.length > 0 ? textFiles : undefined,
      images: imageFiles.length > 0 ? imageFiles : undefined,
    };

    const currentMessages = m.messagesRef.current;
    m.addMessage(userMsg);
    m.addMessage({ role: "assistant", content: "", time: m.now() });

    setAgentStatus(STATUS.thinking);
    setThinking(true);

    // ALL modes (ask, code, plan) go through the background worker
    // which uses native NVIDIA tool calling with M3_TOOL_DEFINITIONS.
    // Lazy-load the heavy background-worker module chain on first message.
    const imageDataUrls = imageFiles.map(img => img.dataUrl);
    const bgWorker = await loadBackgroundWorker();
    bgWorker.setFileSystemAccess(readLocalFile, writeLocalFile, editLocalFile, localTree, localContents, activeDirName || "");
    // 6th arg: the full prompt content (typed text + pasted/attached file
    // blocks). Without it the model only sees the typed text and never the
    // pasted content.
    // Use the LIVE conversationId ref, not the closure value: sendMessageInner
    // is created once at mount, so `convo.conversationId` here was always null
    // — tagging every task with conversationId=null, which made the
    // subscriber's isCurrentConvo guard skip the reply write-back and DB save
    // for every message after the first in a loaded conversation.
    bgWorker.runInBackground(text, convoIdRef.current, currentMessages, mode, imageDataUrls, contentWithFiles, effort, { model });
    // thinking stays true until bg task completes — subscriber handles it
    setAgentStatus("");
  }, []);

  // Stable ref for the subscriber to call
  const sendMessageRef = useRef(sendMessageInner);
  sendMessageRef.current = sendMessageInner;

  // Public sendMessage — wraps inner and shows toast if queued
  const sendMessage = useCallback(async (
    text: string,
    fullContent: string,
    textFiles: AttachedFile[],
    imageFiles: { name: string; dataUrl: string; size: number }[],
    mode: AgentMode = "ask",
    effort?: string,
    model?: string
  ) => {
    // ── Slash commands (client-side navigation/panels — zero backend) ──
    const trimmed = text.trim();
    if (trimmed.startsWith("/") && !trimmed.includes("\n")) {
      const router = routerRef.current;
      switch (trimmed.split(/\s+/)[0]) {
        case "/runs":
          router.push("/runs");
          return;
        case "/manager":
          router.push("/manager");
          return;
        case "/memory": {
          import("@/components/AppLayout").then((m) => m.openMemoryPanel()).catch(() => {});
          return;
        }
        case "/queue":
          router.push("/manager");
          return;
      }
    }

    // If something is already running, queue it instead
    if (thinkingRef.current) {
      const item: QueuedPrompt = {
        id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        text, fullContent, textFiles, imageFiles, mode, effort, model,
        addedAt: Date.now(),
      };
      setQueue(prev => [...prev, item]);
      toast(`Queued: "${text.slice(0, 40)}${text.length > 40 ? "..." : ""}"`, "info");
      return;
    }
    await sendMessageInner(text, fullContent, textFiles, imageFiles, mode, effort, model);
  }, [toast]);

  // Listen for "apply annotations" from artifact cards: pinned visual
  // feedback on screenshots is submitted as a Code-mode follow-up task so
  // the agent reads the brief and edits the code (Antigravity-style loop).
  // Uses the PUBLIC sendMessage so the task queues while another is running.
  useEffect(() => {
    const handler = (e: Event) => {
      const { prompt } = (e as CustomEvent<{ prompt: string }>).detail || {};
      if (!prompt) return;
      void sendMessage("Update the app based on pinned visual feedback", prompt, [], [], "code");
    };
    window.addEventListener("orplex:apply-annotations", handler);
    return () => window.removeEventListener("orplex:apply-annotations", handler);
  }, [sendMessage]);

  const addToQueue = useCallback((
    text: string,
    fullContent: string,
    textFiles: AttachedFile[],
    imageFiles: { name: string; dataUrl: string; size: number }[],
    mode: AgentMode = "ask",
    model?: string,
    effort?: string
  ) => {
    const item: QueuedPrompt = {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text, fullContent, textFiles, imageFiles, mode, effort, model,
      addedAt: Date.now(),
    };
    setQueue(prev => [...prev, item]);
    toast(`Queued: "${text.slice(0, 40)}${text.length > 40 ? "..." : ""}"`, "info");
  }, [toast]);

  const removeFromQueue = useCallback((id: string) => {
    setQueue(prev => prev.filter(q => q.id !== id));
  }, []);

  const clearQueue = useCallback(() => {
    setQueue([]);
  }, []);

  // Use background task display content only if it's actively running for THIS conversation
  // Don't overlay loaded conversation messages with stale background task content
  const isActiveBgTask = bgTask && bgTask.status !== "done" && bgTask.status !== "error" && bgTask.conversationId === convo.conversationId;
  const displayMessages = isActiveBgTask && bgTask?.displayContent
    ? [...msg.messages.slice(0, -1), { role: "assistant" as const, content: bgTask.displayContent, time: msg.messages[msg.messages.length - 1]?.time || "" }]
    : msg.messages;

  return {
    messages: displayMessages,
    setMessages: msg.setMessages,
    conversationId: convo.conversationId,
    loading: thinking,
    loadingConvo: convo.loadingConvo,
    agentStatus: bgTask?.statusDetail || agentStatus,
    newChat: () => {
      convo.newChat(); msg.clearMessages(); setAgentStatus(""); setQueue([]);
      setFailedModels({}); // fresh chat → no failure trail anywhere
    },
    sendMessage,
    stop: () => {
      // Abort the in-flight agent request FIRST and synchronously — a new
      // message sent right after Stop starts a fresh task/controller, and a
      // deferred abort would then kill that new task instead of this one.
      abortCurrentTask();
      // Stopping means stop: drop queued prompts too, so nothing fires after
      // the current task is cancelled.
      const queuedCount = queueRef.current.length;
      if (queuedCount > 0) {
        setQueue([]);
        toast(
          `Stopped — ${queuedCount} queued prompt${queuedCount > 1 ? "s" : ""} cancelled`,
          "info"
        );
      }
      setThinking(false);
      setStreaming(false);
      setAgentStatus("");
      setBgTask(null);
      // User pressed Stop — whatever failed before, THIS stop is the latest
      // word. The auto-retry swap must not fire on the next send.
      setFailedModels({});
    },
    agentEvents: [],
    agentRunning: (bgTask?.status === "streaming" || bgTask?.status === "tool_executing"),
    isStreaming: streaming || thinking,
    isEmpty: msg.isEmpty,
    bgTask,
    todos: bgTask?.todos || [],
    question: bgTask?.question && !bgTask.question.answered ? bgTask.question : null,
    answerQuestion: async (answer: string) => {
      const { answerQuestion: answerFn } = await import("@/lib/background-chat");
      answerFn(answer);
    },
    // Queue
    queue,
    addToQueue,
    removeFromQueue,
    clearQueue,
    // Auto-retry: models that failed in THIS conversation (most recent first)
    // and a one-shot clearer the composer calls after consuming the swap.
    failedModels: failedModels[convo.conversationId ?? ""] ?? [],
    clearFailedModels: () => setFailedModels(prev => {
      const key = convo.conversationId ?? "";
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    }),
    // One-click Retry: resend a failed exchange's ORIGINAL prompt (with its
    // stamped mode/effort/model/files). Uses the PUBLIC sendMessage so a
    // retry while another task runs queues instead of clobbering it. The old
    // [FAILED] bubble stays in history until the new exchange lands below it.
    // `currentMode` covers worker-path stamps, which carry no meta.
    retryMessage: useCallback((assistantIdx: number, currentMode?: AgentMode) => {
      const exchange = findFailedExchange(msgRef.current.messages, assistantIdx);
      if (!exchange) return;
      const meta = exchange.meta ?? {};
      const text = userTypedText(exchange.user.content);
      // Rebuild the original fullContent: the typed text PLUS the attached
      // file blocks, in exactly the format ChatInput's emit uses. Without
      // this a retry silently dropped the attachments' CONTENT (the chips
      // re-rendered, but the model never saw the file bodies again).
      const files = (meta.files ?? []) as AttachedFile[];
      let fullContent = text;
      if (files.length > 0) {
        fullContent += files
          .map((f) => `\n\n---\n**File: \`${f.name}\`** (${formatFileSize(f.size)})\n\`\`\`\n${f.content}\n\`\`\``)
          .join("");
      }
      void sendMessage(
        text,
        fullContent,
        files,
        meta.images ?? [],
        (meta.mode as AgentMode) ?? currentMode ?? "ask",
        meta.effort,
        meta.model,
      );
    }, [sendMessage]),
  };
}
