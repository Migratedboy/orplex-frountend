"use client";

import { Suspense, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useToast } from "@/components/Toast";
import { useChatSession } from "@/hooks/useChatSession";
import { AgentMode } from "@/components/ModeSelector";
import { MessageSkeleton } from "@/components/Skeleton";

// Lazy-load heavy components — only needed on the chat page
const WelcomeSection = dynamic(() => import("@/components/WelcomeSection"), { ssr: false });
const MessageList = dynamic(() => import("@/components/MessageList"), { ssr: false });
const ChatInput = dynamic(() => import("@/components/ChatInput"), { ssr: false });
const DragDropZone = dynamic(() => import("@/components/DragDropZone"), { ssr: false });
const FilePreviewModal = dynamic(() => import("@/components/FilePreviewModal"), { ssr: false });
const TodoBar = dynamic(() => import("@/components/TodoBar"), { ssr: false });
const QuestionCard = dynamic(() => import("@/components/QuestionCard"), { ssr: false });

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

  const sendingRef = useRef(false);
  const handleSend = async (text: string, fullContent: string, textFiles: any[], imageFiles: any[], mode: AgentMode) => {
    if (sendingRef.current) return; // Prevent double-send (sync ref, no async lag)
    sendingRef.current = true;
    try {
      await session.sendMessage(text, fullContent, textFiles, imageFiles, mode);
    } finally {
      sendingRef.current = false;
    }
  };

  const handleFastAnswer = async (userMessage: string) => {
    if (fastLoading) return;
    setFastLoading(true);
    // Cancel the background task so it doesn't overwrite the fast answer
    try {
      const { cancelTask } = await import("@/lib/background-chat");
      cancelTask();
    } catch {}
    try {
      const res = await fetch("/api/chat/fast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: userMessage }] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let content = "";
      // Find the last assistant message and update it
      const msgs = session.setMessages;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.content) {
                content += parsed.content;
                // Update the last assistant message
                msgs(prev => {
                  const updated = [...prev];
                  for (let i = updated.length - 1; i >= 0; i--) {
                    if (updated[i].role === "assistant") {
                      updated[i] = { ...updated[i], content };
                      break;
                    }
                  }
                  return updated;
                });
              }
            } catch {}
          }
        }
      }
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
    <DragDropZone onFilesDropped={(dropped) => { toast(`${dropped.length} file(s) dropped`, "success"); }}>
        {session.isEmpty ? (
          <WelcomeSection />
        ) : (
          <Suspense fallback={<LoadingMessages />}>
            <MessageList
              messages={session.messages}
              agentEvents={session.agentEvents}
              agentRunning={session.agentRunning}
              agentStatus={fastLoading ? "Fast model answering…" : session.agentStatus}
              onFastAnswer={handleFastAnswer}
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
          onFastAnswer={handleFastAnswer}
          lastUserMessage={session.messages.filter(m => m.role === "user").pop()?.content}
          queue={session.queue}
          onQueueAdd={session.addToQueue}
          onQueueRemove={session.removeFromQueue}
          onQueueClear={session.clearQueue}
        />

      {showPreview && <FilePreviewModal files={[]} onRemove={() => {}} onClose={() => setShowPreview(false)} />}
    </DragDropZone>
  );
}
