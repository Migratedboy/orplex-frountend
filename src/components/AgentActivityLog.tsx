"use client";

import { useState, useEffect, useRef } from "react";
import { IconChevronRight, IconX, IconCheck, IconFilePlus, IconTerminal, IconBrain, IconCircle } from "./Icons";

export interface ActivityEntry {
  timestamp: number;
  type: "info" | "success" | "error" | "tool" | "file" | "thinking";
  message: string;
  agent?: string;
}

interface AgentActivityLogProps {
  entries: ActivityEntry[];
  isRunning?: boolean;
  maxHeight?: number;
}

const TYPE_CONFIG: Record<ActivityEntry["type"], { color: string; Icon: React.ComponentType<{ size?: number; className?: string }> }> = {
  info: { color: "var(--text-secondary, #9ca3af)", Icon: IconChevronRight },
  success: { color: "var(--success, #22c55e)", Icon: IconCheck },
  error: { color: "var(--error, #ef4444)", Icon: IconX },
  tool: { color: "var(--accent, #ff6b00)", Icon: IconTerminal },
  file: { color: "var(--info, #3b82f6)", Icon: IconFilePlus },
  thinking: { color: "var(--accent, #ff6b00)", Icon: IconBrain },
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export default function AgentActivityLog({
  entries,
  isRunning = false,
  maxHeight = 200,
}: AgentActivityLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 30);
  };

  if (entries.length === 0 && !isRunning) return null;

  return (
    <div className="activity-log">
      <div className="activity-log-header">
        <span className="activity-log-title">Activity</span>
        {isRunning && (
          <span className="activity-log-status">
            <span className="activity-log-dot" />
            Live
          </span>
        )}
      </div>
      <div
        className="activity-log-body"
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ maxHeight }}
      >
        {entries.map((entry, i) => {
          const { color, Icon } = TYPE_CONFIG[entry.type] || TYPE_CONFIG.info;
          return (
            <div key={i} className="activity-log-entry" style={{ color }}>
              <span className="activity-log-time">{formatTime(entry.timestamp)}</span>
              <span className="activity-log-icon">
                <Icon size={12} />
              </span>
              {entry.agent && (
                <span className="activity-log-agent">[{entry.agent}]</span>
              )}
              <span className="activity-log-message">{entry.message}</span>
            </div>
          );
        })}
        {isRunning && (
          <div className="activity-log-entry activity-log-cursor">
            <IconLoader size={12} className="activity-log-spinner" />
          </div>
        )}
      </div>
    </div>
  );
}

function IconLoader({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className}>
      <line x1="12" y1="2" x2="12" y2="6" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
      <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
    </svg>
  );
}
