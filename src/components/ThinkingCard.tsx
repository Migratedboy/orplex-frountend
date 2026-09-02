"use client";

import { useState, useEffect, useRef } from "react";
import { IconCheck, IconLoader } from "./Icons";

interface ThinkingCardProps {
  content: string;
  isThinking?: boolean;
}

export default function ThinkingCard({ content, isThinking = false }: ThinkingCardProps) {
  const [expanded, setExpanded] = useState(true); // Default expanded so text is visible
  const [elapsed, setElapsed] = useState(0);
  const finalTimeRef = useRef(0);
  const startTimeRef = useRef(Date.now());
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isThinking) {
      // Capture final time when thinking stops
      finalTimeRef.current = Date.now() - startTimeRef.current;
      return;
    }
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTimeRef.current);
    }, 100);
    return () => clearInterval(interval);
  }, [isThinking]);

  useEffect(() => {
    if (expanded && bodyRef.current && isThinking) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [content, expanded, isThinking]);

  const displayTime = isThinking ? elapsed : finalTimeRef.current;
  const seconds = (displayTime / 1000).toFixed(1);
  const hasContent = content.length > 0;

  return (
    <div className={`thinking-pill ${isThinking ? "thinking-pill--active" : "thinking-pill--done"}`}>
      <button
        className="thinking-pill-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <div className="thinking-pill-left">
          {isThinking ? (
            <span className="thinking-pill-spinner">
              <IconLoader size={12} />
            </span>
          ) : (
            <span className="thinking-pill-check">
              <IconCheck size={12} />
            </span>
          )}
          <span className="thinking-pill-label">
            {isThinking ? "Thinking..." : "Reasoning Complete"}
          </span>
        </div>
        <div className="thinking-pill-right">
          {(isThinking || hasContent) && (
            <span className="thinking-pill-time">{seconds}s</span>
          )}
          <span className="thinking-pill-chevron">{expanded ? "\u2212" : "+"}</span>
        </div>
      </button>
      {expanded && (
        <div className="thinking-pill-body" ref={bodyRef}>
          <div className="thinking-pill-content">
            {hasContent ? content : (isThinking ? "Waiting for reasoning..." : "No reasoning content")}
            {isThinking && <span className="thinking-pill-cursor">{"\u258C"}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
