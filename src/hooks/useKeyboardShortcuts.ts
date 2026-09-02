"use client";

import { useEffect, useRef } from "react";

interface ShortcutHandlers {
  onSearch?: () => void;
  onNewChat?: () => void;
  onStop?: () => void;
}

export function useKeyboardShortcuts({ onSearch, onNewChat, onStop }: ShortcutHandlers) {
  // Store handlers in refs to avoid re-registering listeners on every render
  const handlersRef = useRef({ onSearch, onNewChat, onStop });
  handlersRef.current = { onSearch, onNewChat, onStop };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const h = handlersRef.current;

      // Ctrl+K or Cmd+K — Focus search
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        const searchInput = document.querySelector<HTMLInputElement>('[placeholder*="Search"]');
        searchInput?.focus();
        h.onSearch?.();
      }

      // Ctrl+N or Cmd+N — New chat
      if ((e.ctrlKey || e.metaKey) && e.key === "n") {
        e.preventDefault();
        h.onNewChat?.();
      }

      // Escape — Stop generation
      if (e.key === "Escape") {
        h.onStop?.();
      }
    };

    window.addEventListener("keydown", handleKeyDown, { passive: true });
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []); // Empty deps — handlers read from ref, never stale
}
