"use client";

import { useRef, useEffect, useState } from "react";
import { VirtualList } from "./VirtualList";
import MessageContent from "./MessageContent";
import ThinkingCard from "./ThinkingCard";
import ToolCallDisplay from "./ToolCallDisplay";
import { MessageSkeleton } from "./Skeleton";
import ClarificationCard from "./ClarificationCard";
import { Message } from "@/hooks/useMessages";
import { AgentEvent, isToolCallEvent, isToolResultEvent } from "@/lib/types";
import type { RunPhase, PendingQuestion } from "@/lib/background-chat";
import { isFailedMessage } from "@/lib/message-retry";
import { downloadAsMarkdown } from "@/lib/file-download";
import { formatFileSize, getFileIcon } from "@/lib/file-utils";
import { IconDownload } from "./Icons";

/** Strip workspace context from user message for display */
function stripWorkspaceContext(content: string): string {
  let cleaned = content.replace(/\[WORKSPACE:[\s\S]*?(?=User request:)/, "");
  if (cleaned.startsWith("[WORKSPACE:")) {
    const idx = cleaned.indexOf("User request:");
    if (idx !== -1) cleaned = cleaned.slice(idx + "User request:".length).trim();
  }
  return cleaned || content;
}

// A single renderable item is either a Message or a synthetic AgentEvent
type RenderableItem = {
  kind: "message";
  msg: Message;
  index: number;
} | {
  kind: "event";
  event: AgentEvent;
  index: number;
};

/**
 * Identity-based React key. Messages carry no stable id, and a bare index
 * key leaks per-row state (MessageRow's `settled`) across conversations:
 * switching threads reuses index keys for different content. Content-derived
 * keys change with the content, so state never bleeds (the trailing index
 * only disambiguates same-ms duplicates; order is append-only).
 */
function msgKey(msg: Message, index: number): string {
  const head = (msg.content || "").slice(0, 32);
  return `msg-${msg.role}-${msg.time}-${msg.content?.length ?? 0}-${head}-${index}`;
}

interface MessageListProps {
  messages: Message[];
  agentEvents: AgentEvent[];
  agentRunning: boolean;
  agentStatus?: string;
  onFastAnswer?: (userMessage: string) => void;
  /** One-click Retry on a failed assistant bubble (resends the original prompt). */
  onRetryMessage?: (assistantIdx: number) => void;
  /** Index of the bubble whose retry is currently being sent (shows "Retrying…"). */
  retryingIdx?: number | null;
  /** Per-turn run phase — drives the end-of-stream tail indicator. */
  runPhase?: RunPhase;
  /** Live status detail for that phase ("analysing [src/app/page.tsx]"…). */
  runLabel?: string;
  /** Pending ask_clarification question — renders the card instead of the tail. */
  clarification?: PendingQuestion | null;
  /** Clarifications asked this run — feeds the ">2 = rephrase" hint. */
  clarificationAskCount?: number;
  onAnswerClarification?: (answer: string) => void;
  onSkipClarification?: () => void;
}

/** Estimate height based on content length */
function estimateMessageHeight(item: RenderableItem): number {
  if (item.kind === "event") return 48;
  const msg = item.msg;
  const lines = (msg.content || "").split("\n").length;
  const hasFiles = msg.files && msg.files.length > 0;
  const hasImages = msg.images && msg.images.length > 0;
  let h = 56; // base (padding + name + time)
  if (lines > 1) h += Math.min(lines * 18, 300); // text lines
  if (hasFiles) h += msg.files!.length * 28;
  if (hasImages) h += Math.min(msg.images!.length * 80, 320);
  return Math.min(h, 600);
}

export default function MessageList({ messages, agentEvents, agentRunning, agentStatus, onFastAnswer, onRetryMessage, retryingIdx = null, runPhase = "idle", runLabel = "", clarification = null, clarificationAskCount = 1, onAnswerClarification, onSkipClarification }: MessageListProps) {
  // Merge messages + agent events into a single ordered list
  const items: RenderableItem[] = [];
  messages.forEach((msg, i) => {
    items.push({ kind: "message", msg, index: i });
  });
  agentEvents.forEach((event, i) => {
    items.push({ kind: "event", event, index: i });
  });

  // Use virtual list for 20+ items, fall back to simple rendering
  const useVirtual = items.length > 20;

  // Growth of the in-flight answer — drives auto-scroll while streaming (the
  // item count alone doesn't change as text arrives). A new clarification
  // counts as growth too, so the card scrolls into view with the run.
  const lastMsg = messages[messages.length - 1];
  const streamKey = `${items.length}:${lastMsg?.content?.length ?? 0}:${clarification?.question ?? ""}`;

  // === ONE indicator at a time ============================================
  // The original "Thinking Xs" block owns the thinking state outright (it
  // already counts elapsed time and matches the message style): it is only
  // ever LIVE while the run is in phase "thinking", and the tail indicator
  // never renders in that phase. The two never overlap:
  //   thinking     → Thinking block (live)      · tail hidden
  //   running_tool → Thinking block settled/absent · tail "Working…"
  //   streaming    → Thinking block settled/absent · tail "Responding…"
  // A pending clarification owns the slot the other way: the card IS the
  // tail while waiting — spinner and card never share the screen.
  const liveThinking = runPhase === "thinking";
  const pendingClarify = clarification && !clarification.answered ? clarification : null;
  const tail = pendingClarify ? (
    <ClarificationCard
      question={pendingClarify.question}
      context={pendingClarify.context}
      options={pendingClarify.options}
      allowFreeText={pendingClarify.allowFreeText}
      askCount={clarificationAskCount}
      onAnswer={onAnswerClarification}
      onSkip={onSkipClarification}
    />
  ) : (
    <RunTail
      phase={liveThinking ? "idle" : runPhase}
      label={runLabel || agentStatus}
    />
  );

  if (useVirtual) {
    return (
      <div className="messages-scroll">
        <VirtualList
          items={items}
          estimatedHeight={80}
          overscan={8}
          getItemKey={(item) =>
            item.kind === "message"
              ? msgKey(item.msg, item.index)
              : `evt-${item.index}`
          }
          className="messages-container"
          renderItem={(item) => (
            <RenderableItem
              item={item}
              agentRunning={agentRunning}
              liveThinking={liveThinking}
              isLast={item.kind === "message" && item.index === messages.length - 1}
              onRetryMessage={onRetryMessage}
              retryingIdx={retryingIdx}
            />
          )}
        />
        {tail}
      </div>
    );
  }

  return (
    <div className="messages-scroll">
      <div className="messages-container">
        {messages.map((msg, i) => (
          <MessageRow
            key={msgKey(msg, i)}
            msg={msg}
            index={i}
            agentRunning={agentRunning}
            liveThinking={liveThinking}
            isLast={i === messages.length - 1}
            onRetryMessage={onRetryMessage}
            retryingIdx={retryingIdx}
          />
        ))}

        {agentEvents.map((event, i) => {
          if (isToolCallEvent(event)) {
            return (
              <ToolCallDisplay
                key={`evt-${i}`}
                tool={event.tool}
                args={event.args}
              />
            );
          }
          if (isToolResultEvent(event)) {
            return (
              <ToolCallDisplay
                key={`evt-${i}`}
                tool={event.tool}
                result={event.result}
                success={event.success}
              />
            );
          }
          return null;
        })}

        {tail}
        <AutoScrollAnchor itemsLength={items.length} streamKey={streamKey} />
      </div>
    </div>
  );
}

// === Individual row components ===

function MessageRow({ msg, index, agentRunning, liveThinking = false, isLast, onRetryMessage, retryingIdx = null }: {
  msg: Message;
  index: number;
  agentRunning: boolean;
  /** Run is in the thinking phase — the only time the Thinking block is live. */
  liveThinking?: boolean;
  isLast: boolean;
  onRetryMessage?: (assistantIdx: number) => void;
  retryingIdx?: number | null;
}) {
  const pending = agentRunning && isLast;
  // The Thinking block counts only while the model is actually thinking; once
  // a tool runs or text streams it settles to its "Thought for Xs" done state
  // and the tail indicator takes over — never both.
  const thinkingLive = pending && liveThinking;
  // One-shot: play the footer's fade-in exactly when THIS turn resolves, not
  // every time an already-finished message re-renders.
  const [settled, setSettled] = useState(false);
  const wasPending = useRef(pending);
  useEffect(() => {
    if (wasPending.current && !pending) setSettled(true);
    wasPending.current = pending;
  }, [pending]);
  const footerClass = pending
    ? "msg-time-actions msg-time-actions--pending"
    : settled
      ? "msg-time-actions msg-time-actions--settled"
      : "msg-time-actions";
  return (
    <div className={msg.role === "user" ? "msg-user" : "msg-assistant"}>
      <div className={msg.role === "user" ? "msg-bubble msg-bubble-user" : "msg-bubble msg-bubble-assistant"}>

        {msg.role === "user" && msg.files && msg.files.length > 0 && (
          <div className="msg-files">
            {msg.files.map((f, fi) => (
              <span key={fi} className="msg-file-chip">{getFileIcon(f.name)} {f.name} ({formatFileSize(f.size)})</span>
            ))}
          </div>
        )}
        {msg.role === "user" && msg.images && msg.images.length > 0 && (
          <div className="msg-images">
            {msg.images.filter(img => img.dataUrl && /^(https?:|data:image\/(png|jpe?g|gif|webp);base64,)/i.test(img.dataUrl)).map((img, ii) => (
              <div key={ii} className="msg-image-thumb">
                <img src={img.dataUrl} alt={img.name} />
                <div className="msg-image-label">{img.name}</div>
              </div>
            ))}
          </div>
        )}
        {msg.role === "assistant" ? (
          <div className="msg-content msg-content-assistant">
            <img src="/logo.svg" alt="Orplex" className="msg-avatar" width={28} height={28} />
            <div className="msg-content-text">
              {msg.content ? (
                <MessageContent
                  content={msg.content}
                  isThinking={thinkingLive}
                  runLive={pending}
                  onRetry={
                    isFailedMessage(msg.content) && onRetryMessage
                      ? () => onRetryMessage(index)
                      : undefined
                  }
                  retrying={retryingIdx === index}
                />
              ) : thinkingLive ? (
                <ThinkingCard content="" isThinking={true} />
              ) : null}
              {/* Footer stays reserved (height held) but hidden until the turn
                  resolves — timestamps + Save are only meaningful once the
                  answer is final. Fades in via CSS when --pending drops. */}
              <div className={footerClass}>
                <div className="msg-time">{msg.time}</div>
                {msg.content && (
                  <button onClick={() => downloadAsMarkdown(msg.content)} className="code-block-btn" title="Save response as .md">
                    <IconDownload size={12} /> Save
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="msg-content msg-content-user">
            {msg.role === "user" ? (
              <MessageContent content={stripWorkspaceContext(msg.content)} />
            ) : msg.content}
          </div>
        )}
        {msg.role === "user" && <div className="msg-time msg-time-user">{msg.time}</div>}
      </div>
    </div>
  );
}

/** Wrapper that renders a RenderableItem — used by the virtual list */
function RenderableItem({ item, agentRunning, liveThinking = false, isLast, onRetryMessage, retryingIdx = null }: {
  item: RenderableItem;
  agentRunning: boolean;
  /** Run is in the thinking phase — the only time the Thinking block is live. */
  liveThinking?: boolean;
  isLast: boolean;
  onRetryMessage?: (assistantIdx: number) => void;
  retryingIdx?: number | null;
}) {
  if (item.kind === "event") {
    const event = item.event;
    if (isToolCallEvent(event)) {
      return <ToolCallDisplay tool={event.tool} args={event.args} />;
    }
    if (isToolResultEvent(event)) {
      return <ToolCallDisplay tool={event.tool} result={event.result} success={event.success} />;
    }
    return null;
  }
  return (
    <MessageRow
      msg={item.msg}
      index={item.index}
      agentRunning={agentRunning}
      liveThinking={liveThinking}
      isLast={isLast}
      onRetryMessage={onRetryMessage}
      retryingIdx={retryingIdx}
    />
  );
}

/** Fallback labels when a phase carries no status detail of its own.
 *  ("thinking" has none — RunTail never renders it, see above.) */
const RUN_LABEL: Partial<Record<RunPhase, string>> = {
  running_tool: "Working…",
  streaming: "Responding…",
  done: "Done",
  error: "Failed",
  stopped: "Stopped",
};

/**
 * End-of-stream tail indicator. Renders below the last message while the turn
 * is live, holds its outcome long enough to be read, then fades (150ms) and
 * unmounts. Height is reserved while visible so the answer landing never
 * shoves the scroll position around.
 *
 * Never renders for "thinking": the original "Thinking Xs" block already owns
 * that state (elapsed time + animation), so the two can't both be on screen.
 */
function RunTail({ phase, label }: { phase: RunPhase; label?: string }) {
  if (phase === "idle" || phase === "thinking") return null;
  const terminal = phase === "done" || phase === "error" || phase === "stopped";
  const icon =
    phase === "done" ? "check"
      : phase === "error" ? "error"
        : phase === "stopped" ? "stop_circle"
          : "progress_activity";
  const text = (label ?? "").trim() || RUN_LABEL[phase] || "";

  return (
    <div
      className="run-tail"
      data-phase={phase}
      data-terminal={terminal ? "" : undefined}
      role="status"
      aria-live="polite"
    >
      <span className={`run-tail-icon ms ${terminal ? "" : "ms-spin"}`} aria-hidden="true">{icon}</span>
      <span className="run-tail-label">{text}</span>
    </div>
  );
}

/** Auto-scrolls to the bottom — but only while the reader is already near it */
function AutoScrollAnchor({ itemsLength, streamKey }: { itemsLength: number; streamKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const prevItems = useRef(itemsLength);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scroller = el.closest(".messages-scroll") as HTMLElement | null;
    // Scrolled up to read earlier output? Then new growth must not yank the
    // view down — the reader owns the scroll position from here.
    if (scroller) {
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (distance > 220) return;
    }
    // New bubbles glide in; streamed text on the current one lands instantly
    // (a smooth tween restarted every chunk would stutter).
    const itemsChanged = prevItems.current !== itemsLength;
    prevItems.current = itemsLength;
    el.scrollIntoView({ behavior: itemsChanged ? "smooth" : "auto", block: "end" });
  }, [itemsLength, streamKey]);
  return <div ref={ref} />;
}
