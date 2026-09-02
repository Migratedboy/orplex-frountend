"use client";

import { useState } from "react";

interface OnboardingProps {
  onComplete: () => void;
}

const STEPS = [
  {
    title: "Welcome to Orplex",
    description: "An AI coding assistant that can read, write, and edit your files directly.",
    icon: "🚀",
  },
  {
    title: "Connect Your Workspace",
    description: "Click \"Open Folder\" in the sidebar to give the AI access to your project files.",
    icon: "📁",
  },
  {
    title: "Ask Anything",
    description: "Describe what you want to build or fix. The AI will create a plan and execute it step by step.",
    icon: "💬",
  },
  {
    title: "Review Changes",
    description: "Every file change goes through an approval dialog. You're always in control.",
    icon: "✅",
  },
];

export default function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  return (
    <div className="onboarding-overlay">
      <div className="onboarding-card">
        <div className="onboarding-icon">{current.icon}</div>
        <h2 className="onboarding-title">{current.title}</h2>
        <p className="onboarding-desc">{current.description}</p>

        <div className="onboarding-dots">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`onboarding-dot ${i === step ? "onboarding-dot--active" : ""} ${i < step ? "onboarding-dot--done" : ""}`}
            />
          ))}
        </div>

        <div className="onboarding-actions">
          {step > 0 && (
            <button className="onboarding-btn onboarding-btn--secondary" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <button
            className="onboarding-btn onboarding-btn--primary"
            onClick={() => (isLast ? onComplete() : setStep(step + 1))}
          >
            {isLast ? "Get Started" : "Next"}
          </button>
        </div>

        <button className="onboarding-skip" onClick={onComplete}>
          Skip tour
        </button>
      </div>
    </div>
  );
}
