"use client";
import React, { useState } from "react";

interface SplitViewProps {
  left: React.ReactNode;
  right: React.ReactNode;
  defaultRatio?: number;
}

export default function SplitView({ left, right, defaultRatio = 50 }: SplitViewProps) {
  const [ratio, setRatio] = useState(defaultRatio);
  const [dragging, setDragging] = useState(false);

  const handleMouseDown = () => setDragging(true);
  const handleMouseUp = () => setDragging(false);
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return;
    const container = (e.target as HTMLElement).parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const newRatio = ((e.clientX - rect.left) / rect.width) * 100;
    setRatio(Math.max(20, Math.min(80, newRatio)));
  };

  return (
    <div
      className="flex h-full"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <div className="overflow-auto" style={{ width: `${ratio}%` }}>{left}</div>
      <div
        className="w-1 bg-gray-200 dark:bg-gray-700 hover:bg-orange-400 cursor-col-resize flex-shrink-0"
        onMouseDown={handleMouseDown}
      />
      <div className="overflow-auto" style={{ width: `${100 - ratio}%` }}>{right}</div>
    </div>
  );
}
