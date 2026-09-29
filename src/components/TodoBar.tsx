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
            <span className="ms">{allDone ? "check_circle" : "check_box_outline_blank"}</span>
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
                  {item.done && <span className="ms ms-sm">check</span>}
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
