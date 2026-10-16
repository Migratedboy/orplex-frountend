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
import { subscribeBackgroundChat, abortCurrentTask, readTaskSnapshot, clearTaskSnapshot, getCurrentTask, deriveRunPhase, runPhaseLabel, type BackgroundTask, type RunPhase } from "@/lib/background-chat";
import { normalizeThinkingBlocks } from "@/lib/stream-reader";
import { onAgentStatus } from "@/lib/agent-events";
import type { AgentEvent } from "@/lib/types";
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

/** A task this silent is dead, not "still thinking" — see the stall watchdog. */
const STALL_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * Label for a live run phase. The worker stamps generic per-turn placeholders
 * ("Thinking…", "Processing…") as the status detail — surfacing those in the
 * tail would put a SECOND thinking label on screen next to the Thinking block,
 * so they fall back to the phase's own wording. Real detail (rate-limit waits,
 * "Reading src/app/page.tsx…") is kept verbatim.
 */
function describeRunPhase(phase: RunPhase, detail: string): string {
  const d = detail.trim();
  if (!d) return runPhaseLabel(phase);
  if (/^(thinking|processing)\b/i.test(d)) return runPhaseLabel(phase);
  return d;
}

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
  // === Per-turn run phase (UI-only view of the task store) =================
  // Every run-status surface renders from these three: the end-of-stream tail,
  // the sidebar card, and the composer's Stop/Stopped state. Terminal phases
  // are held briefly (see phaseTimerRef) so the tail can fade instead of
  // vanishing, then fall back to "idle".
  const [runPhase, setRunPhase] = useState<RunPhase>("idle");
  // Timeline events emitted by the agent loop. `agentEvents` was a hardcoded
  // `[]`, so the timeline's event rows (tool calls, and now the compaction
  // divider) could never render in a live chat. Subscribing to the existing
  // agent-events bus wires it additively — it only collects events, it does not
  // touch the message or streaming path.
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  // Compaction markers accumulate for the life of the view. The bus is
  // module-level, so the unsubscribe MUST be returned or a remount would
  // double-count every subsequent event.
  useEffect(() => {
    return onAgentStatus((event) => {
      if (event.type !== "compaction") return;
      setAgentEvents((prev) => [
        ...prev,
        {
          type: "compacted",
          tokensBefore: event.tokensBefore,
          tokensAfter: event.tokensAfter,
          mode: event.mode,
          ...(event.summary ? { summary: event.summary } : {}),
        },
      ]);
    });
  }, []);

  // Clear on conversation change. Without this a new thread inherits the
  // previous thread's compaction markers — they sit at the bottom of an empty
  // conversation, claiming turns that are not there — and the array grows for
  // the life of the view.
  useEffect(() => {
    setAgentEvents([]);
  }, [convo.conversationId]);
  const [runLabel, setRunLabel] = useState("");
  const [stopped, setStopped] = useState(false);
  const phaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The Stop note is transient — acknowledge the stop, then get out of the way.
  const stoppedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearStoppedTimer = () => {
    if (stoppedTimerRef.current) {
      clearTimeout(stoppedTimerRef.current);
      stoppedTimerRef.current = null;
    }
  };
  /** Surface the Stop note for a few seconds, then let it retire itself. */
  const showStoppedNote = () => {
    clearStoppedTimer();
    setStopped(true);
    stoppedTimerRef.current = setTimeout(() => {
      setStopped(false);
      stoppedTimerRef.current = null;
    }, 8000);
  };
  // Last time the active task produced ANY update — a stream that goes silent
  // for the whole stall window is dead, not "still thinking".
  const lastActivityRef = useRef(0);
  const clearPhaseTimer = () => {
    if (phaseTimerRef.current) {
      clearTimeout(phaseTimerRef.current);
      phaseTimerRef.current = null;
    }
  };
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
      const isActive = task && (task.status === "streaming" || task.status === "tool_executing" || task.status === "awaiting_approval" || task.status === "waiting_for_input");
      const isStreaming = task && (task.status === "streaming" || task.status === "tool_executing");
      // A genuinely new task clears the abandoned marker, so it can never mask
      // a later run's write-back.
      if (task && task.id !== abandonedTaskIdRef.current) {
        abandonedTaskIdRef.current = "";
      }
      setBgTask(isActive ? task : null);
      setStreaming(!!isStreaming);

      // Run phase for the UI. Active tasks mirror the store on every notify;
      // terminal tasks hold their outcome briefly so the tail indicator can
      // fade out, then settle back to "idle". A null task leaves the current
      // phase alone (its own hold timer owns the fade).
      if (isActive && task) {
        lastActivityRef.current = Date.now();
        clearPhaseTimer();
        const phase = deriveRunPhase(task);
        setRunPhase(phase);
        setRunLabel(describeRunPhase(phase, task.statusDetail));
        clearStoppedTimer();
        setStopped(false);
      } else if (task) {
        const phase = deriveRunPhase(task);
        clearPhaseTimer();
        setRunPhase(phase);
        setRunLabel(
          phase === "stopped" ? "Stopped"
            : phase === "error" ? (task.statusDetail || "Failed")
              : "Done"
        );
        phaseTimerRef.current = setTimeout(() => {
          setRunPhase("idle");
          setRunLabel("");
          phaseTimerRef.current = null;
        }, 1500);
      }

      if (!isActive) {
        setThinking(false);
        setAgentStatus("");

        // The user may have navigated to a DIFFERENT conversation while this
        // background task was running. Never write into the store or save a
        // conversation that isn't the one currently on screen — the message
        // store holds the active conversation's bubbles.
        //
        // `task.conversationId === convoIdRef.current` alone is NOT enough: a
        // brand-new chat has conversationId === null on BOTH sides, so
        // `null === null` read as "current". After New Chat the abandoned task
        // would write its reply into the now-empty store (silently dropped,
        // since the updater bails on prev.length === 0) and still fire the DB
        // save below — resurfacing as a stray conversation in the sidebar
        // under a different thread. `abandonedTaskIdRef` pins the exact task
        // the user walked away from, independent of any other module's abort.
        const isCurrentConvo =
          !!task &&
          task.id !== abandonedTaskIdRef.current &&
          task.conversationId === convoIdRef.current;

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
              // Prefix match, not equality: when images persisted, the bubble content is
        // `text` plus the appended `![attachment](attachment:...)` refs, while
        // task.userMessage holds the bare `text`. Equality therefore never held,
        // so any run carrying an image wrote back into nothing - an empty bubble
        // with no [FAILED] stamp and therefore no Retry. Scanning backwards means
        // the most recent match wins.
        if (updated[i].role === "user" && updated[i].content.startsWith(task.userMessage)) {
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
    //
    // A task the user STOPPED is `status === "error"` + `aborted`, so this
    // used to skip it entirely and the partial answer was lost on reload —
    // the "Stopped" note was all that survived. An interrupted answer is
    // still the answer the user has, so persist it; only skip when there is
    // genuinely no content (a failed task with nothing but an error is
    // handled by the [FAILED] stamping path below).
    const shouldPersist =
      isCurrentConvo &&
      task &&
      (task.status === "done" || (task.status === "error" && task.aborted)) &&
      task.displayContent;
    if (shouldPersist) {
      const userMsg = task.userMessage || "";
      const assistantMsg = normalizeThinkingBlocks(task.displayContent!);
      if (userMsg && assistantMsg) {
        convoRef.current
        .saveConversation(userMsg, assistantMsg, undefined, directoryNameRef.current, (msg) => toastRef.current(msg, "error"))
        .catch(() => {
          /* already surfaced via onSaveError */
        });
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
              // Prefix match, not equality: when images persisted, the bubble content is
        // `text` plus the appended `![attachment](attachment:...)` refs, while
        // task.userMessage holds the bare `text`. Equality therefore never held,
        // so any run carrying an image wrote back into nothing - an empty bubble
        // with no [FAILED] stamp and therefore no Retry. Scanning backwards means
        // the most recent match wins.
        if (updated[i].role === "user" && updated[i].content.startsWith(task.userMessage)) {
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
                // Same fallback the success path has: if the user bubble was
                // not located (its content drifted, e.g. attachment refs were
                // appended), stamp the trailing assistant placeholder instead of
                // leaving a permanently empty bubble with no [FAILED] marker and
                // therefore no one-click Retry.
                const tail = updated[updated.length - 1];
                if (tail.role === "assistant" && !tail.content) {
                  updated[updated.length - 1] = {
                    ...tail,
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

  // === Stall watchdog ======================================================
  // The worker resolves every run it owns (completeTask / failTask / abort),
  // but a stream that dies without ever reaching the worker — dropped network,
  // a hung provider socket — would otherwise leave the tail indicator and the
  // sidebar dot pulsing forever. Any task update resets the clock; six silent
  // minutes means the run is dead, so abort it and let the normal Stop path
  // resolve the UI to "stopped". Pending questions / approvals are never
  // stalled out: waiting on the user is not silence.
  useEffect(() => {
    const id = setInterval(() => {
      const task = getCurrentTask();
      if (!task) return;
      const phase = deriveRunPhase(task);
      if (phase !== "thinking" && phase !== "running_tool" && phase !== "streaming") return;
      if (task.status === "awaiting_approval") return;
      if (task.question && !task.question.answered) return;
      if (Date.now() - lastActivityRef.current < STALL_TIMEOUT_MS) return;
      abortCurrentTask();
      setRunPhase("stopped");
      setRunLabel("No response — run stopped");
      showStoppedNote();
    }, 15000);
    return () => {
      clearInterval(id);
      clearPhaseTimer();
      clearStoppedTimer();
    };
  }, []);

  // Listen for New Chat event from sidebar
  useEffect(() => {
    const handler = () => {
      // Abandon whatever is running BEFORE resetting state, and abort it here
      // rather than relying on AppLayout's listener: that abort is an async
      // dynamic import, so a task could finish inside the gap and still be
      // written back. New Chat means "stop working".
      abandonedTaskIdRef.current = bgTaskRef.current?.id ?? "";
      void import("@/lib/background-chat")
        .then((m) => m.abortCurrentTask())
        .catch(() => {});
      convoRef.current.newChat();
      msgRef.current.clearMessages();
      setAgentStatus("");
      setBgTask(null);
      setThinking(false);
      setStreaming(false);
    clearPhaseTimer();
    setRunPhase("idle");
    setRunLabel("");
    setStopped(false);
    // The hook's own returned newChat() clears the queue, but this event path
    // (Sidebar button and Ctrl+N) did not - and page.tsx never unmounts on the
    // "/" navigation, so the state survived. Queue two prompts, click New Chat,
    // then send anything: the new task completes, the subscriber auto-dequeues,
    // and the old thread's queued prompt is appended to the NEW chat and saved
    // under the new conversation.
    setQueue([]);
    queueRef.current = [];
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
  // The task the user explicitly walked away from (New Chat). Cleared when a
  // new task starts, so it can never mask a later run.
  const abandonedTaskIdRef = useRef<string>("");
  const bgTaskRef = useRef(bgTask);
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
    // The snapshot is the ONLY remaining copy of an interrupted run's partial
    // output, and saveConversation swallows its own failures — so clearing it
    // unconditionally destroyed the only copy whenever the save failed
    // (offline, DB down, 500, or a 404 because the conversation was deleted).
    // Clear only after a confirmed save.
    c.saveConversation(userText, assistantText, snap.conversationId || undefined, directoryNameRef.current)
      .then(() => {
        t("Your previous task was interrupted by the reload — partial output restored.", "info");
        clearTaskSnapshot();
      })
      .catch(() => {
        // Still not persisted — keep the snapshot so a later attempt can save it.
        t("Restored your partial output, but saving it failed. It is kept in this tab only — retrying or closing the tab will lose it.", "error");
      });
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

    // Archives (.zip) cannot be inlined into the prompt. Persist each one to
    // local disk, then tell the model the real workspace path so it can call
    // extract_archive. Without this line an attached zip is inert: the model
    // has no way to reach it.
    const archiveFiles = textFiles.filter((f) => f.type === "archive" && f.dataUrl);
    if (archiveFiles.length > 0) {
      const { persistImages } = await import("@/lib/client-attachments");
      const stored = await persistImages(
        archiveFiles.map((f) => ({ name: f.name, dataUrl: f.dataUrl!, size: f.size })),
      );
      if (stored.length > 0) {
        const { extractStoredArchive, extractedArchiveToPrompt } = await import(
          "@/lib/client-attachments"
        );
        const blocks: string[] = [];
        for (const s of stored) {
          const stem = s.name.replace(/\.[^.]+$/, "") || "extracted";
          const ext = await extractStoredArchive(s.ref, stem);
          if (ext && ext.files.length > 0) {
            // The real fix for "the AI cannot see the .zip": the tool loop runs
            // on the cloud backend, which cannot read this machine's disk, so a
            // path is useless to it. Ship the actual contents with the request.
            blocks.push(extractedArchiveToPrompt(s.name, ext));
          } else {
            const rel = ".orplex/attachments/" + s.ref.slice("attachment:".length);
            // Say so PLAINLY. A silent fallback made this look like "the model
            // ignores my zip" when the truth was the upload/extraction never
            // happened.
            blocks.push(
              `[ARCHIVE: ${s.name}] COULD NOT BE UNPACKED. The file is stored at ${rel} ` +
                `but extraction failed on this machine, so its contents are NOT available to you. ` +
                `Tell the user plainly that you cannot see the archive's contents and ask them to ` +
                `re-attach the files individually, rather than guessing at what is inside.`,
            );
          }
        }
        contentWithFiles =
          contentWithFiles + "\n\n" + blocks.join("\n\n");
      }
    }

  // Persist attached images to the user's LOCAL disk (never Postgres) and swap
  // the inline data URLs for local URLs. Best-effort: if storage fails the
  // message still sends with the original data URLs, it just will not survive
  // a reload.
  let storedImages: { name: string; dataUrl: string; size: number; ref: string }[] = [];
  if (imageFiles.length > 0) {
    const { persistImages, contentWithRefs } = await import("@/lib/client-attachments");
    storedImages = await persistImages(imageFiles);
  }

  const userMsg: Message = {
    role: "user",
    content:
      text ||
      (textFiles.length > 0
        ? `Uploaded ${textFiles.length} file(s)`
        : `Uploaded ${imageFiles.length} image(s)`),
    time: m.now(),
    files: textFiles.length > 0 ? textFiles : undefined,
    // Prefer the locally-stored copy so the thumbnail keeps rendering after a
    // reload; fall back to the inline data URL if local storage failed.
    images:
      storedImages.length > 0
        ? storedImages.map((s) => ({ name: s.name, dataUrl: s.dataUrl, size: s.size }))
        : imageFiles.length > 0
          ? imageFiles
          : undefined,
  };

  // The persisted body carries only the refs, so the saved conversation stays
  // text-only and the image is rehydrated from local disk on load.
  if (storedImages.length > 0) {
    const { contentWithRefs } = await import("@/lib/client-attachments");
    userMsg.content = contentWithRefs(userMsg.content, storedImages.map((s) => s.ref));
  }

    const currentMessages = m.messagesRef.current;
    m.addMessage(userMsg);
    m.addMessage({ role: "assistant", content: "", time: m.now() });

    setAgentStatus(STATUS.thinking);
    setThinking(true);
    // Fresh run — any prior terminal phase / Stop note is history now.
    clearPhaseTimer();
    clearStoppedTimer();
    setRunPhase("idle");
    setRunLabel("");
    setStopped(false);
    lastActivityRef.current = Date.now();

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
      // Stopped is a real outcome: pin it so the tail + composer note render
      // it (the store's own notify already reported the abort a tick earlier).
      clearPhaseTimer();
      setRunPhase("stopped");
      setRunLabel("Stopped");
      showStoppedNote();
      phaseTimerRef.current = setTimeout(() => {
        setRunPhase("idle");
        setRunLabel("");
        phaseTimerRef.current = null;
      }, 1500);
      // User pressed Stop — whatever failed before, THIS stop is the latest
      // word. The auto-retry swap must not fire on the next send.
      setFailedModels({});
    },
    agentEvents,
    agentRunning: (bgTask?.status === "streaming" || bgTask?.status === "tool_executing"),
    isStreaming: streaming || thinking,
    // Per-turn run state for the tail indicator + composer Stop note.
    runPhase,
    runLabel,
    stopped,
    isEmpty: msg.isEmpty,
    bgTask,
    todos: bgTask?.todos || [],
    // Legacy QuestionCard question (ask_question / safety prompt). The
    // ask_clarification tool renders as the message-stream card instead.
    question: bgTask?.question && !bgTask.question.answered && bgTask.question.kind !== "clarification" ? bgTask.question : null,
    // Pending ask_clarification question — the tail ClarificationCard owns it
    // until the user answers or skips (answered records live in the
    // transcript as [CLARIFIED] markers, not here).
    clarification: bgTask?.question && bgTask.question.kind === "clarification" && !bgTask.question.answered ? bgTask.question : null,
    clarificationAskCount: bgTask?.clarificationCount ?? 0,
    answerQuestion: async (answer: string) => {
      const { answerQuestion: answerFn } = await import("@/lib/background-chat");
      answerFn(answer);
    },
    skipClarification: async () => {
      const { answerQuestion: answerFn, CLARIFICATION_SKIP } = await import("@/lib/background-chat");
      answerFn(CLARIFICATION_SKIP);
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
