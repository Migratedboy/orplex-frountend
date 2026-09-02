"use client";

export type AgentMode = "ask" | "plan" | "code";

interface ModeSelectorProps {
  mode: AgentMode;
  onChange: (mode: AgentMode) => void;
}

const MODES: { id: AgentMode; label: string; desc: string }[] = [
  { id: "ask", label: "Ask", desc: "Simple chat, no file access" },
  { id: "plan", label: "Plan", desc: "Analyze codebase, create plan" },
  { id: "code", label: "Code", desc: "Edit files, run commands" },
];

export default function ModeSelector({ mode, onChange }: ModeSelectorProps) {
  return (
    <div className="mode-selector">
      {MODES.map((m) => (
        <button
          key={m.id}
          onClick={() => onChange(m.id)}
          className={`mode-btn ${mode === m.id ? "active" : ""}`}
          title={m.desc}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
