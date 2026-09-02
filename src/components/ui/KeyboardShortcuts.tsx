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
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-96 max-h-[80vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h3 className="font-semibold text-gray-800 dark:text-gray-200">Keyboard Shortcuts</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">X</button>
        </div>
        <div className="p-4 space-y-4">
          {categories.map((cat) => (
            <div key={cat}>
              <h4 className="text-xs font-medium text-gray-500 uppercase mb-2">{cat}</h4>
              {SHORTCUTS.filter((s) => s.category === cat).map((s) => (
                <div key={s.keys} className="flex items-center justify-between py-1">
                  <span className="text-sm text-gray-700 dark:text-gray-300">{s.description}</span>
                  <kbd className="px-2 py-0.5 text-xs bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 font-mono">
                    {s.keys}
                  </kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
