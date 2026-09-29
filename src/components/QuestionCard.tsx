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
            <span className="ms">close</span>
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
            <span className="ms question-option-arrow">arrow_forward</span>
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
                <span className="ms ms-sm">edit</span>
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
