"use client";

import { useRef, useEffect } from "react";
import { VirtualList } from "./VirtualList";
import MessageContent from "./MessageContent";
import ThinkingCard from "./ThinkingCard";
import ToolCallDisplay from "./ToolCallDisplay";
import { MessageSkeleton } from "./Skeleton";
import { Message } from "@/hooks/useMessages";
import { AgentEvent, isToolCallEvent, isToolResultEvent } from "@/lib/types";
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
}

interface MessageListProps {
  messages: Message[];
  agentEvents: AgentEvent[];
  agentRunning: boolean;
  agentStatus?: string;
  onFastAnswer?: (userMessage: string) => void;
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

export default function MessageList({ messages, agentEvents, agentRunning, agentStatus, onFastAnswer }: MessageListProps) {
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

  if (useVirtual) {
    return (
      <div className="messages-scroll">
        <VirtualList
          items={items}
          estimatedHeight={80}
          overscan={8}
          getItemKey={(item) =>
            item.kind === "message"
              ? `msg-${item.index}`
              : `evt-${item.index}`
          }
          className="messages-container"
          renderItem={(item) => (
            <RenderableItem
              item={item}
              agentRunning={agentRunning}
              isLast={item.kind === "message" && item.index === messages.length - 1}
            />
          )}
        />
      </div>
    );
  }

  return (
    <div className="messages-scroll">
      <div className="messages-container">
        {messages.map((msg, i) => (
          <MessageRow
            key={i}
            msg={msg}
            index={i}
            agentRunning={agentRunning}
            isLast={i === messages.length - 1}
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

        <AutoScrollAnchor itemsLength={items.length} />
      </div>
    </div>
  );
}

// === Individual row components ===

function MessageRow({ msg, index, agentRunning, isLast }: {
  msg: Message;
  index: number;
  agentRunning: boolean;
  isLast: boolean;
}) {
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
            {msg.images.filter(img => img.dataUrl).map((img, ii) => (
              <div key={ii} className="msg-image-thumb">
                <img src={img.dataUrl} alt={img.name} />
                <div className="msg-image-label">{img.name}</div>
              </div>
            ))}
          </div>
        )}
        {msg.role === "assistant" ? (
          <div className="msg-content msg-content-assistant">
            <img src="/logo.png" alt="Orplex" className="msg-avatar" width={28} height={28} />
            <div className="msg-content-text">
              {msg.content ? (
                <MessageContent content={msg.content} isThinking={agentRunning && isLast} />
              ) : agentRunning && isLast ? (
                <ThinkingCard content="" isThinking={true} />
              ) : null}
              <div className="msg-time-actions">
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
function RenderableItem({ item, agentRunning, isLast }: {
  item: RenderableItem;
  agentRunning: boolean;
  isLast: boolean;
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
      isLast={isLast}
    />
  );
}

/** Auto-scrolls to bottom when new items arrive */
function AutoScrollAnchor({ itemsLength }: { itemsLength: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth" });
  }, [itemsLength]);
  return <div ref={ref} />;
}
