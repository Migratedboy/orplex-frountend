"use client";

import { useState, useEffect, useRef } from "react";
import LatticeLoader from "./LatticeLoader";

interface ThinkingCardProps {
  content: string;
  isThinking?: boolean;
}

/**
 * Collapsible "Thinking" pill backed by LatticeLoader. Streams the model's
 * reasoning live while `isThinking` is true (lattice animates + timer runs),
 * then collapses to a done-state pill that can be re-opened to review the
 * reasoning.
 */
export default function ThinkingCard({ content, isThinking = false }: ThinkingCardProps) {
  const [wasThinking, setWasThinking] = useState(isThinking);
  const [expanded, setExpanded] = useState(isThinking);
  // Seconds to freeze into the done-state loader (LatticeLoader's timer
  // restarts on remount, so the final duration is captured here).
  const [finalSeconds, setFinalSeconds] = useState(0);
  const startRef = useRef<number | null>(null);

  // When a new thinking session starts on this card, reset the clock.
  useEffect(() => {
    // First pass: establish the start time post-hydration (impure Date.now()
    // can't run during render).
    if (startRef.current == null) startRef.current = Date.now();
    if (isThinking && !wasThinking) {
      startRef.current = Date.now();
      setFinalSeconds(0);
    }
    if (isThinking) {
      setWasThinking(true);
    }
  }, [isThinking, wasThinking]);

  // When thinking stops, freeze the duration and collapse.
  useEffect(() => {
    if (!isThinking && wasThinking) {
      setFinalSeconds((prev) => (prev > 0 ? prev : (Date.now() - (startRef.current ?? Date.now())) / 1000));
      setWasThinking(false);
      setExpanded(false);
    }
  }, [isThinking, wasThinking]);

  const hasContent = content.trim().length > 0;
  const wordCount = content.trim().split(/\s+/).filter(Boolean).length;
  // Rough token estimate (≈4 chars/token for English). Live while streaming,
  // frozen once done since `content` stops changing — makes the effort
  // setting's effect visible per answer (Low ≪ High).
  const tokenEstimate = Math.ceil(content.length / 4);

  return (
    <div className="thinking-card">
      <button
        type="button"
        className="thinking-card__head"
        onClick={() => hasContent && setExpanded((v) => !v)}
        aria-expanded={hasContent ? expanded : undefined}
        title={hasContent ? (expanded ? "Hide reasoning" : "Show reasoning") : undefined}
      >
        <LatticeLoader
          label="Thinking"
          doneLabel="Thought for"
          status={isThinking ? "working" : "done"}
          pattern="orbit"
          grid={3}
          shape="round"
          color="#FF6B00"
          doneColor="#22c55e"
          cellSize={5}
          gap={2}
          fontSize={12}
          showTimer={isThinking || finalSeconds > 0}
          elapsed={isThinking ? undefined : finalSeconds > 0 ? finalSeconds : undefined}
        />
        {hasContent && (
          <span className="thinking-card__meta">
            · ~{tokenEstimate.toLocaleString()} tokens
            {!isThinking && wordCount > 0 ? ` · ${wordCount} words` : ""}
          </span>
        )}
        {hasContent && (
          <span className="thinking-card__chevron" aria-hidden="true">
            {expanded ? "−" : "+"}
          </span>
        )}
      </button>
      {hasContent && expanded && (
        <div className="thinking-card__reasoning">
          <pre className="thinking-card__reasoning-text">
            {content.trim()}
            {isThinking && <span className="thinking-card__cursor" />}
          </pre>
        </div>
      )}
    </div>
  );
}
