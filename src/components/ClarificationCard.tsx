"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export interface ClarificationPayload {
  q: string;
  c?: string;
  a: string;
}

interface ClarificationCardProps {
  /** Interactive mode: the pending question (from the task store). */
  question?: string;
  context?: string;
  options?: string[];
  allowFreeText?: boolean;
  /** How many clarifications this run has asked — >2 shows the rephrase hint. */
  askCount?: number;
  onAnswer?: (answer: string) => void;
  onSkip?: () => void;
  /** Compact "answered" mode: renders question + answer pill from a transcript record. */
  compact?: boolean;
  data?: ClarificationPayload;
}

/**
 * The ask_clarification card. Interactive while the run waits; compact and
 * inert once answered (or when replayed from the [CLARIFIED] transcript
 * marker after a reload). Lives in the message stream — never a modal.
 */
export default function ClarificationCard({
  question,
  context,
  options = [],
  allowFreeText = true,
  askCount = 1,
  onAnswer,
  onSkip,
  compact = false,
  data,
}: ClarificationCardProps) {
  const [typed, setTyped] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const doneRef = useRef(false);
  const optionsRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const firstPillRef = useRef<HTMLButtonElement | null>(null);

  const q = data?.q ?? question ?? "";
  const ctxLine = data?.c ?? context;
  const answerText = data?.a;

  // (g) Focus lands on the first option pill — or the freetext input when
  // there are no options — the moment the card appears.
  useEffect(() => {
    if (compact) return;
    if (options.length > 0) firstPillRef.current?.focus();
    else if (allowFreeText) inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (compact) {
    return (
      <div className="clarify-card clarify-card--answered" data-state="answered" aria-live="polite">
        <span className="clarify-q-compact">{q}</span>
        <span className="clarify-a-pill">{answerText}</span>
      </div>
    );
  }

  const answer = (value: string) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onAnswer?.(value);
  };

  const skip = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onSkip?.();
  };

  const pickOption = (option: string, index: number) => {
    if (doneRef.current) return;
    setSelected(index);
    // Brief selected state so the tap registers visually before the card
    // collapses into its answered form.
    window.setTimeout(() => answer(option), 130);
  };

  const onOptionsKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const pills = Array.from(optionsRef.current?.querySelectorAll("button") ?? []);
    if (pills.length === 0) return;
    const current = pills.indexOf(document.activeElement as HTMLButtonElement);
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const next = current === -1 ? 0 : (current + delta + pills.length) % pills.length;
    pills[next]?.focus();
  };

  return (
    <div
      className="clarify-card"
      data-state="active"
      aria-live="polite"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          skip();
        }
      }}
    >
      <div className="clarify-head">
        <span className="clarify-emoji" aria-hidden="true">🤔</span>
        <span className="clarify-title">Need a quick clarification</span>
      </div>

      {ctxLine && <div className="clarify-context">{ctxLine}</div>}
      <div className="clarify-question">{q}</div>

      {options.length > 0 && (
        <div
          className="clarify-options"
          role="group"
          aria-label="Clarification options"
          ref={optionsRef}
          onKeyDown={onOptionsKeyDown}
        >
          {options.map((option, i) => (
            <button
              key={i}
              type="button"
              ref={i === 0 ? firstPillRef : undefined}
              className={`clarify-pill${selected === i ? " clarify-pill--selected" : ""}`}
              aria-label={`Option ${String.fromCharCode(65 + i)}: ${option}`}
              onClick={() => pickOption(option, i)}
            >
              {option}
            </button>
          ))}
        </div>
      )}

      {allowFreeText && (
        <div className="clarify-freetext">
          <span className="clarify-freetext-hint">or type your answer...</span>
          <div className="clarify-input-wrap">
            <input
              ref={inputRef}
              className="clarify-input"
              type="text"
              value={typed}
              placeholder="Type your answer"
              aria-label="Type your clarification answer"
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && typed.trim()) answer(typed.trim());
              }}
            />
            <button
              type="button"
              className="clarify-send"
              aria-label="Send answer"
              disabled={!typed.trim()}
              onClick={() => typed.trim() && answer(typed.trim())}
            >
              <span className="ms" aria-hidden="true">arrow_upward</span>
            </button>
          </div>
        </div>
      )}

      {askCount > 2 && (
        <div className="clarify-warning" role="status">
          The agent is having trouble understanding the task. Consider rephrasing your request.
        </div>
      )}
    </div>
  );
}
