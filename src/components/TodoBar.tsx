"use client";

import { useState } from "react";

interface TodoItem {
  text: unknown;
  done: boolean;
}

interface TodoBarProps {
  items: TodoItem[];
}

export default function TodoBar({ items }: TodoBarProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (!items || items.length === 0) return null;

  const completed = items.filter((t) => t.done).length;
  const total = items.length;
  const allDone = completed === total;

  return (
    <div className="todo-bar">
      <button
        className="todo-bar-header"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="todo-bar-left">
          <div className={`todo-bar-icon ${allDone ? "todo-bar-icon--done" : ""}`}>
            {allDone ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <path d="M9 12l2 2 4-4" />
              </svg>
            )}
          </div>
          <span className="todo-bar-title">
            {allDone ? "All tasks complete" : `Task plan`}
          </span>
          <span className="todo-bar-count">
            {completed}/{total}
          </span>
        </div>
        <span className="todo-bar-chevron">{collapsed ? "+" : "\u2212"}</span>
      </button>

      {!collapsed && (
        <div className="todo-bar-items">
          {items.map((item, i) => {
            const text = typeof item.text === "string"
              ? item.text
              : typeof item.text === "object" && item.text !== null
                ? JSON.stringify(item.text)
                : String(item.text ?? "");
            return (
              <div
                key={i}
                className={`todo-bar-item ${item.done ? "todo-bar-item--done" : ""}`}
              >
                <div className={`todo-bar-check ${item.done ? "todo-bar-check--done" : ""}`}>
                  {item.done && (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </div>
                <span className="todo-bar-text">{text}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
