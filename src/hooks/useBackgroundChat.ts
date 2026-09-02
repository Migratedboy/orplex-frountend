"use client";

import { useState, useEffect } from "react";
import { subscribeBackgroundChat, type BackgroundTask } from "@/lib/background-chat";

/**
 * Subscribe to the background chat store.
 * Returns the current background task (if any) and whether one is running.
 * This hook survives page navigation — the store is a global singleton.
 */
export function useBackgroundChat(): {
  task: BackgroundTask | null;
  isRunning: boolean;
} {
  const [task, setTask] = useState<BackgroundTask | null>(null);

  useEffect(() => {
    return subscribeBackgroundChat(setTask);
  }, []);

  return {
    task,
    isRunning: task !== null && task.status !== "done" && task.status !== "error",
  };
}
