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
    <div className="fixed inset-0 bg-black/60 z-[100] flex items-center justify-center">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-80 p-6">
        <div className="flex items-center justify-between mb-4">
          <span className="text-xs text-gray-500">Step {step + 1} of {STEPS.length}</span>
          <button onClick={onComplete} className="text-xs text-gray-400 hover:text-gray-600">Skip</button>
        </div>
        <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-2">{current.title}</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">{current.description}</p>
        <div className="flex gap-2">
          <button
            onClick={() => setStep(step + 1)}
            className="flex-1 px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {step === STEPS.length - 1 ? "Get Started" : "Next"}
          </button>
          {step > 0 && (
            <button
              onClick={() => setStep(step - 1)}
              className="px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg text-sm"
            >
              Back
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
