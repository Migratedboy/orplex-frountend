"use client";
import React, { useEffect, useState } from "react";

interface Shortcut {
  keys: string;
  description: string;
  category: string;
}

const SHORTCUTS: Shortcut[] = [
  { keys: "Ctrl+Enter", description: "Send message", category: "Chat" },
  { keys: "Ctrl+K", description: "Command palette", category: "Navigation" },
  { keys: "Ctrl+/", description: "Toggle terminal", category: "Panel" },
  { keys: "Ctrl+B", description: "Toggle sidebar", category: "Panel" },
  { keys: "Ctrl+P", description: "Toggle preview", category: "Panel" },
  { keys: "Esc", description: "Stop generation", category: "Chat" },
  { keys: "Ctrl+N", description: "New chat", category: "Chat" },
  { keys: "Ctrl+.", description: "Toggle dark mode", category: "Theme" },
];

export function useKeyboardShortcuts(handlers: Record<string, () => void>) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = [];
      if (e.ctrlKey || e.metaKey) key.push("Ctrl");
      if (e.shiftKey) key.push("Shift");
      if (e.altKey) key.push("Alt");
      key.push(e.key === " " ? "Space" : e.key.toUpperCase());
      const combo = key.join("+");

      if (handlers[combo]) {
        e.preventDefault();
        handlers[combo]();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handlers]);
}

export function ShortcutsPanel({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  if (!visible) return null;
  const categories = [...new Set(SHORTCUTS.map((s) => s.category))];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="sc-panel" onClick={(e) => e.stopPropagation()}>
        <div className="sc-header">
          <span className="sc-title">Keyboard Shortcuts</span>
          <button className="sc-close" onClick={onClose} aria-label="Close keyboard shortcuts">&times;</button>
        </div>
        <div className="sc-body">
          {categories.map((cat) => (
            <div key={cat}>
              <div className="sc-cat">{cat}</div>
              {SHORTCUTS.filter((s) => s.category === cat).map((s) => (
                <div key={s.keys} className="sc-row">
                  <span className="sc-desc">{s.description}</span>
                  <kbd className="sc-kbd">{s.keys}</kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
