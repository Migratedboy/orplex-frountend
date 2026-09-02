"use client";
import React from "react";

interface TaskProgressProps {
  current: number;
  total: number;
  currentFile?: string;
  status: "running" | "paused" | "done" | "error";
}

export default function TaskProgress({ current, total, currentFile, status }: TaskProgressProps) {
  if (total === 0) return null;
  const percent = Math.round((current / total) * 100);

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden mb-3">
      <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800 flex items-center justify-between text-sm">
        <span className="text-gray-700 dark:text-gray-300 font-medium">
          {status === "done" ? "Complete" : status === "error" ? "Error" : "Generating..."}
        </span>
        <span className="text-gray-500 text-xs">{current}/{total} files</span>
      </div>
      <div className="px-4 py-3">
        <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              status === "done" ? "bg-green-500" : status === "error" ? "bg-red-500" : "bg-orange-500"
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>
        {currentFile && status === "running" && (
          <p className="mt-1 text-xs text-gray-500 truncate">Writing: {currentFile}</p>
        )}
      </div>
    </div>
  );
}
