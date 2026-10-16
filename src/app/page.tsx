"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { apiFetch } from "@/lib/api-base";
import { useToast } from "@/components/Toast";
import SessionInsightsPopup from "@/components/SessionInsightsPopup";
import { useChatSession } from "@/hooks/useChatSession";
import { AgentMode } from "@/components/ModeSelector";
import { MessageSkeleton } from "@/components/Skeleton";

// Lazy-load heavy components — only needed on the chat page
const MessageList = dynamic(() => import("@/components/MessageList"), { ssr: false });
const ChatInput = dynamic(() => import("@/components/ChatInput"), { ssr: false });
const DragDropZone = dynamic(() => import("@/components/DragDropZone"), { ssr: false });
const FilePreviewModal = dynamic(() => import("@/components/FilePreviewModal"), { ssr: false });
const TodoBar = dynamic(() => import("@/components/TodoBar"), { ssr: false });
const QuestionCard = dynamic(() => import("@/components/QuestionCard"), { ssr: false });
const FirstRunExperience = dynamic(() => import("@/components/FirstRunExperience"), { ssr: false });

function LoadingMessages() {
  return (
    <div className="messages-scroll">
      <MessageSkeleton count={3} />
    </div>
  );
}

export default function ChatPage() {
  const { toast } = useToast();
  const session = useChatSession();
  const [showPreview, setShowPreview] = useState(false);
  const [agentMode, setAgentMode] = useState<AgentMode>("ask");
  const [fastLoading, setFastLoading] = useState(false);
  // Index of the failed bubble whose Retry is being sent (button feedback).
  const [retryingIdx, setRetryingIdx] = useState<number | null>(null);

  // ChatInput is dynamically imported (ssr:false), so its attach bridge is
  // resolved at runtime rather than imported as a value.
  const droppedFilesBridgeRef = useRef<((files: unknown[]) => void) | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import("@/components/ChatInput").then((m) => {
      if (cancelled) return;
      droppedFilesBridgeRef.current = (files) => m.droppedFilesBridge.add?.(files as never);
    });
    return () => {
      cancelled = true;
      droppedFilesBridgeRef.current = null;
    };
  }, []);

  const sendingRef = useRef(false);  const handleSend = async (text: string, fullContent: string, textFiles: any[], imageFiles: any[], mode: AgentMode, effort?: string, model?: string) => {
    if (sendingRef.current) return; // Prevent double-send (sync ref, no async lag)
    sendingRef.current = true;
    try {
      await session.sendMessage(text, fullContent, textFiles, imageFiles, mode, effort, model);
    } finally {
      sendingRef.current = false;
    }
  };

  // One-click Retry on a failed assistant bubble: resend the ORIGINAL prompt
  // (mode/effort/model come from the failure stamp). Guarded against
  // double-click and against retrying while something else is running.
  const handleRetry = (assistantIdx: number) => {
    if (retryingIdx !== null || session.agentRunning || session.isStreaming) {
      toast("Wait for the current task to finish, then retry.", "info");
      return;
    }
    setRetryingIdx(assistantIdx);
    try {
      session.retryMessage(assistantIdx, agentMode);
      toast("Retrying with the same prompt…", "info");
    } catch {
      toast("Could not retry — the original prompt is no longer available.", "error");
    } finally {
      setRetryingIdx(null);
    }
  };

  const handleFastAnswer = async (userMessage: string) => {
    if (fastLoading) return;
    setFastLoading(true);
    // Kill the background agent so it can't overwrite the fast answer later
    try {
      const { abortCurrentTask } = await import("@/lib/background-chat");
      abortCurrentTask();
    } catch {}

    // Target the assistant bubble that follows the user's own message (the
    // one "Answer Now" was clicked on). Searching the whole store for the
    // last assistant message can overwrite a DIFFERENT conversation's or an
    // older finished reply when history is loaded mid-run.
    let bubbleIdx = -1;
    {
      const msgs = session.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "user" && msgs[i].content === userMessage) {
          bubbleIdx = i + 1;
          break;
        }
      }
    }
    if (bubbleIdx < 0 || bubbleIdx >= session.messages.length) {
      // No matching exchange in the store (e.g. user left the page mid-run and
      // the agent finished in the background). Answer in a fresh pair instead
      // of silently dropping the response.
      session.setMessages(prev => {
        const now = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
        return [
          ...prev,
          { role: "user" as const, content: userMessage, time: now },
          { role: "assistant" as const, content: "", time: now },
        ];
      });
    }

    try {
      const res = await apiFetch("/api/chat/fast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: userMessage }] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let content = "";
      const writeChunk = (next: string) => {
        session.setMessages(prev => {
          // Re-locate the assistant bubble each chunk: if the user's message
          // appears multiple times, pick the one that still has an EMPTY
          // assistant bubble right after it (the one this answer owns).
          for (let i = prev.length - 2; i >= 0; i--) {
            if (prev[i].role === "user" && prev[i].content === userMessage) {
              const idx = i + 1;
              if (idx < prev.length && prev[idx].role === "assistant" && !prev[idx].content) {
                const updated = [...prev];
                updated[idx] = { ...updated[idx], content: next };
                return updated;
              }
            }
          }
          // Fall back to the slot captured at click time if it still exists.
          if (bubbleIdx >= 0 && bubbleIdx < prev.length && prev[bubbleIdx].role === "assistant") {
            const updated = [...prev];
            updated[bubbleIdx] = { ...updated[bubbleIdx], content: next };
            return updated;
          }
          return prev;
        });
      };
      // Partial-event buffer: network chunks don't align with SSE events — a
      // chunk can end mid-JSON, and splitting per-chunk lines silently dropped
      // both halves of a split event (lost answer text). Incomplete tails wait
      // for the next chunk; the final tail is flushed when the stream ends.
      let pending = "";
      const processDataLine = (line: string) => {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;
          try {
            const parsed = JSON.parse(data);
            if (parsed.content) {
              content += parsed.content;
              writeChunk(content);
            }
          } catch {}
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() || "";
        for (const line of lines) {
          processDataLine(line);
        }
      }
      if (pending) processDataLine(pending);
      if (!content) {
        toast("Fast model returned empty response", "error");
      }
    } catch (err) {
      toast(`Fast answer failed: ${(err as Error).message}`, "error");
    } finally {
      setFastLoading(false);
    }
  };

  return (
      <DragDropZone
        onFilesDropped={(dropped) => {
          // Route into the composer's attachment list instead of discarding.
          // This read the files and then threw them away behind a toast, so
          // drag-and-drop was a dead end: the user saw "N files dropped" and
          // nothing was ever attached or sent.
          const bridge = droppedFilesBridgeRef.current;
          if (bridge && dropped.length > 0) {
            bridge(dropped);
            toast(`${dropped.length} file(s) attached`, "success");
          } else {
            toast("Open a conversation first, then drop files to attach them", "info");
          }
        }}
      >
        {session.isEmpty ? (
          <FirstRunExperience />
        ) : (
          <Suspense fallback={<LoadingMessages />}>
            <MessageList
              messages={session.messages}
              agentEvents={session.agentEvents}
              agentRunning={session.agentRunning}
              agentStatus={fastLoading ? "Fast model answering…" : session.agentStatus}
              runPhase={fastLoading ? "streaming" : session.runPhase}
              runLabel={fastLoading ? "Fast model answering…" : session.runLabel}
              clarification={session.clarification}
              clarificationAskCount={session.clarificationAskCount}
              onAnswerClarification={session.answerQuestion}
              onSkipClarification={session.skipClarification}
              onFastAnswer={handleFastAnswer}
              onRetryMessage={handleRetry}
              retryingIdx={retryingIdx}
            />
          </Suspense>
        )}

        <TodoBar items={session.todos} />

        {session.question && (
          <QuestionCard
            question={session.question.question}
            options={session.question.options}
            allowFreeText={session.question.allowFreeText}
            onAnswer={(answer) => session.answerQuestion(answer)}
            onSkip={() => session.answerQuestion("(skipped)")}
          />
        )}

        <ChatInput
          onSend={handleSend}
          onStop={session.stop}
          loading={session.loading}
          agentRunning={session.agentRunning}
          isStreaming={session.isStreaming}
          agentMode={agentMode}
          onModeChange={setAgentMode}
          conversationId={session.conversationId}
          onFastAnswer={handleFastAnswer}
          lastUserMessage={session.messages.filter(m => m.role === "user").pop()?.content}
          queue={session.queue}
          onQueueAdd={session.addToQueue}
          onQueueRemove={session.removeFromQueue}
          onQueueClear={session.clearQueue}
          failedModels={session.failedModels}
          clearFailedModels={session.clearFailedModels}
          stopped={session.stopped}
          onRetryModelSwap={(nextId, failed) => {
            const label = failed[0] ?? "the previous model";
            toast(`Model failed — retrying with ${nextId.split("/").pop() ?? nextId} (was ${label.split("/").pop() ?? label})`, "info");
          }}
        />

      {showPreview && <FilePreviewModal files={[]} onRemove={() => {}} onClose={() => setShowPreview(false)} />}

      {/* Floating, dismissible "what did the agent do" summary. A popup and not
          a RightPanel tab: the panel is a pinned workspace surface, this is a
          glanceable read the user opens and closes. */}
      <SessionInsightsPopup />
    </DragDropZone>
  );
}
