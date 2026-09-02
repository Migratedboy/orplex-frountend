"use client";

import { useState } from "react";

interface QuestionCardProps {
  question: unknown;
  options: unknown[];
  allowFreeText: boolean;
  onAnswer: (answer: string) => void;
  onSkip: () => void;
  questionIndex?: number;
  totalQuestions?: number;
}

export default function QuestionCard({
  question,
  options,
  allowFreeText,
  onAnswer,
  onSkip,
  questionIndex = 1,
  totalQuestions = 1,
}: QuestionCardProps) {
  const [customText, setCustomText] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);

  const handleSelect = (option: string, index: number) => {
    setSelected(index);
    onAnswer(option);
  };

  const handleCustomSubmit = () => {
    if (customText.trim()) {
      onAnswer(customText.trim());
    }
  };

  return (
    <div className="question-card">
      <div className="question-header">
        <span className="question-text">{typeof question === "string" ? question : JSON.stringify(question)}</span>
        <div className="question-nav">
          {totalQuestions > 1 && (
            <span className="question-counter">
              {"<"} {questionIndex} of {totalQuestions} {">"}
            </span>
          )}
          <button className="question-close" onClick={onSkip} title="Dismiss">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div className="question-options">
        {options.map((option, i) => {
            const optText = typeof option === "string" ? option : JSON.stringify(option);
            return (
          <button
            key={i}
            className={`question-option ${selected === i ? "question-option--selected" : ""}`}
            onClick={() => handleSelect(optText, i)}
          >
            <span className="question-option-num">{i + 1}</span>
            <span className="question-option-text">{optText}</span>
            <svg className="question-option-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
          );
        })}

        {allowFreeText && (
          <>
            {!showCustom ? (
              <button
                className="question-option question-option--custom"
                onClick={() => setShowCustom(true)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
                <span>Something else</span>
              </button>
            ) : (
              <div className="question-custom">
                <input
                  className="question-custom-input"
                  type="text"
                  placeholder="Type your answer..."
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCustomSubmit()}
                  autoFocus
                />
                <button
                  className="question-custom-submit"
                  onClick={handleCustomSubmit}
                  disabled={!customText.trim()}
                >
                  Send
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="question-footer">
        <button className="question-skip" onClick={onSkip}>
          Skip
        </button>
      </div>
    </div>
  );
}
