"use client";
import React, { useState } from "react";

interface TourStep {
  title: string;
  description: string;
  target: string;
  position: "top" | "bottom" | "left" | "right";
}

const STEPS: TourStep[] = [
  { title: "Chat", description: "Type your request here. The AI will build, debug, and create files for you.", target: "chat-input", position: "top" },
  { title: "File Tree", description: "See files being created in real-time. Click any file to view its content.", target: "file-tree", position: "right" },
  { title: "Preview", description: "Live website preview. See your app rendered in real-time.", target: "preview", position: "left" },
  { title: "Terminal", description: "Run commands, see build output, and debug issues.", target: "terminal", position: "top" },
];

interface OnboardingTourProps {
  onComplete: () => void;
}

export default function OnboardingTour({ onComplete }: OnboardingTourProps) {
  const [step, setStep] = useState(0);
  const current = STEPS[step];

  if (step >= STEPS.length) {
    onComplete();
    return null;
  }

  return (
    <div className="ot-overlay">
      <div className="ot-card">
        <div className="ot-top">
          <span className="ot-step">Step {step + 1} of {STEPS.length}</span>
          <button onClick={onComplete} className="ot-skip">Skip</button>
        </div>
        <h3 className="ot-title">{current.title}</h3>
        <p className="ot-desc">{current.description}</p>
        <div className="ot-actions">
          <button onClick={() => setStep(step + 1)} className="ot-btn--primary">
            {step === STEPS.length - 1 ? "Get Started" : "Next"}
          </button>
          {step > 0 && (
            <button onClick={() => setStep(step - 1)} className="ot-btn">Back</button>
          )}
        </div>
      </div>
    </div>
  );
}
