"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSSEStream } from "./useSSEStream";
import { useMessages, Message } from "./useMessages";
import { useConversation } from "./useConversation";
import { AttachedFile } from "./useFileProcessor";
import { AgentMode } from "@/components/ModeSelector";
import { useToast } from "@/components/Toast";
import { useFileSystemContext } from "@/components/FileSystemProvider";
import { FileNode } from "./useFileSystem";
import { buildWorkspaceContext } from "@/lib/client-signatures";
import { subscribeBackgroundChat, type BackgroundTask } from "@/lib/background-chat";
// Lazy-load background-worker — it's the heaviest module chain
// Only imported when actually sending a message, not on page load
const loadBackgroundWorker = () => import("@/lib/background-worker");
import { useRouter } from "next/navigation";

// ─── Tool Call Types ────────────────────────────────────────────────────────

interface ToolCall {
  name: string;
  path?: string;
  content?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────



/** Get all file paths under a directory prefix */
function listFilesUnderPath(path: string, nodes: FileNode[]): string {
  const results: string[] = [];
  const walk = (ns: FileNode[]) => {
    for (const n of ns) {
      if (n.kind === "file" && (path === "" || path === "." || n.path.startsWith(path))) {
        results.push(n.path);
      }
      if (n.kind === "directory" && n.children) walk(n.children);
    }
  };
  walk(nodes);
  return results.length > 0 ? results.join("\n") : "No files found at that path.";
}

/** Parse <tool_call>{...}</tool_call> blocks from AI response */
function parseToolCalls(text: string): ToolCall[] {
  const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  const calls: ToolCall[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      calls.push(JSON.parse(match[1].trim()));
    } catch {
      // skip malformed tool calls
    }
  }
  return calls;
}

/** Parse <file path="...">content</file> write-back blocks and apply to disk */
function parseAndWriteFiles(
  content: string,
  writeFile: (path: string, code: string) => Promise<boolean>,
  toast: (msg: string, type: "success" | "error" | "info") => void
) {
  const regex = /<file path="([^"]+)">([\s\S]*?)<\/file>/g;
  let match;
  let count = 0;
  while ((match = regex.exec(content)) !== null) {
    writeFile(match[1], match[2]);
    count++;
  }
  if (count > 0) {
    toast(`Wrote ${count} file(s) to your local workspace.`, "success");
  }
}

/** Safely extract error message string from any error type */
function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return "Unknown error"; }
}

/** Replace the last status line with a result line */
function replaceLastStatus(display: string, resultLine: string): string {
  // Find the last status line pattern: "analysing [path]", "reading [path]", etc.
  const statusRegex = /^(analysing|reading|writing|listing|thinking)\s+\[[^\]]+\]\n?$/m;
  const lines = display.split("\n");
  // Find last matching line from the end
  for (let i = lines.length - 1; i >= 0; i--) {
    if (statusRegex.test(lines[i])) {
      lines[i] = resultLine;
      return lines.join("\n");
    }
  }
  // No status line found — just append
  return display + resultLine + "\n";
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
  addedAt: number;
}

export function useChatSession() {
  const { toast } = useToast();
  const router = useRouter();
  const { stop } = useSSEStream();
  const msg = useMessages();
  const convo = useConversation(msg.setMessages);
  const { directoryName, fileContents, fileTree, readFile, writeFile, editFile } = useFileSystemContext();
  const [agentStatus, setAgentStatus] = useState<string>("");
  const [bgTask, setBgTask] = useState<BackgroundTask | null>(null);
  const [thinking, setThinking] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [queue, setQueue] = useState<QueuedPrompt[]>([]);
  const queueRef = useRef<QueuedPrompt[]>([]);
  const thinkingRef = useRef(false);

  // Keep refs in sync
  useEffect(() => { queueRef.current = queue; }, [queue]);
  useEffect(() => { thinkingRef.current = thinking; }, [thinking]);

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

        // CRITICAL: Write final content back to messages when task completes
        // Otherwise the assistant message stays empty after bgTask is cleared
        if (task && (task.status === "done" || task.status === "error") && task.displayContent) {
          msgRef.current.setMessages(prev => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            if (last.role === "assistant" && !last.content) {
              const updated = [...prev.slice(0, -1), { ...last, content: task.displayContent }];
              return updated;
            }
            return prev;
          });
        }

        // Save conversation to DB when task completes
        if (task && task.status === "done" && task.displayContent) {
          const userMsg = task.userMessage || "";
          const assistantMsg = task.displayContent || "";
          if (userMsg && assistantMsg) {
            convoRef.current.saveConversation(userMsg, assistantMsg).catch(() => {});
          }
        }

        // Auto-dequeue: send the next prompt if one is queued
        const q = queueRef.current;
        if (q.length > 0 && task && (task.status === "done" || task.status === "error")) {
          const next = q[0];
          setQueue(prev => prev.slice(1));
          setTimeout(() => {
            sendMessageRef.current(next.text, next.fullContent, next.textFiles, next.imageFiles, next.mode);
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

  const sendMessageInner = useCallback(async (
    text: string,
    fullContent: string,
    textFiles: AttachedFile[],
    imageFiles: { name: string; dataUrl: string; size: number }[],
    mode: AgentMode = "ask"
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
      const { context } = buildWorkspaceContext(
        localTree,
        localContents,
        text,
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
    bgWorker.runInBackground(text, convo.conversationId, currentMessages, mode, imageDataUrls);
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
    mode: AgentMode = "ask"
  ) => {
    // If something is already running, queue it instead
    if (thinkingRef.current) {
      const item: QueuedPrompt = {
        id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        text, fullContent, textFiles, imageFiles, mode,
        addedAt: Date.now(),
      };
      setQueue(prev => [...prev, item]);
      toast(`Queued: "${text.slice(0, 40)}${text.length > 40 ? "..." : ""}"`, "info");
      return;
    }
    await sendMessageInner(text, fullContent, textFiles, imageFiles, mode);
  }, [toast]);

  const addToQueue = useCallback((
    text: string,
    fullContent: string,
    textFiles: AttachedFile[],
    imageFiles: { name: string; dataUrl: string; size: number }[],
    mode: AgentMode = "ask"
  ) => {
    const item: QueuedPrompt = {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text, fullContent, textFiles, imageFiles, mode,
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
    newChat: () => { convo.newChat(); msg.clearMessages(); setAgentStatus(""); setQueue([]); },
    sendMessage,
    stop: () => {
      stop();
      setThinking(false);
      setStreaming(false);
      setAgentStatus("");
      setBgTask(null);
      // Cancel the background task so it stops processing
      import("@/lib/background-chat").then(m => m.cancelTask());
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
  };
}
