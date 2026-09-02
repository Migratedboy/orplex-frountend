"use client";
import React, { useState } from "react";

interface Model {
  id: string;
  name: string;
  provider: string;
  speed: "fast" | "medium" | "slow";
  quality: "standard" | "high" | "premium";
}

const MODELS: Model[] = [
  { id: "minimax/minimax-m3:free", name: "MiniMax M3", provider: "OpenRouter", speed: "medium", quality: "high" },
  { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", provider: "NVIDIA", speed: "slow", quality: "premium" },
  { id: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron Lightning", provider: "OpenRouter", speed: "fast", quality: "standard" },
];

interface ModelSelectorProps {
  currentModel: string;
  onModelChange: (modelId: string) => void;
}

export default function ModelSelector({ currentModel, onModelChange }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const selected = MODELS.find((m) => m.id === currentModel) || MODELS[0];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors"
      >
        <span className="w-2 h-2 rounded-full bg-green-500" />
        <span className="text-gray-700 dark:text-gray-300">{selected.name}</span>
        <span className="text-xs text-gray-500">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="absolute top-full mt-1 left-0 w-64 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50">
          {MODELS.map((model) => (
            <button
              key={model.id}
              onClick={() => { onModelChange(model.id); setOpen(false); }}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 ${
                model.id === currentModel ? "bg-orange-50 dark:bg-orange-900/20" : ""
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${model.id === currentModel ? "bg-orange-500" : "bg-gray-300"}`} />
              <div className="flex-1 text-left">
                <div className="text-gray-700 dark:text-gray-300">{model.name}</div>
                <div className="text-xs text-gray-500">{model.provider} · {model.speed} · {model.quality}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
