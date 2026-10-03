"use client";

import { useState, useEffect } from "react";
import { useBackgroundChat } from "./useBackgroundChat";

const KEY_PREFIX = "orplex:scratchpad:";
const LAST_KEY = "orplex:scratchpad:last";

/**
 * The agent's scratchpad for the Scratch panel: live text from the task
 * store while a task runs, persisted per task id in localStorage so it
 * survives full app restarts (the worker pushes every update; this hook
 * only mirrors + persists, never the source of truth mid-task).
 */
export function useScratchpad(): { text: string; taskId: string | null; live: boolean } {
  const { task } = useBackgroundChat();
  const [persisted, setPersisted] = useState<string>("");
  const [persistedTaskId, setPersistedTaskId] = useState<string | null>(null);
  // Primitive deps (not the task object — it is a new reference every store
  // notify, which would re-run persistence on every render).
  const taskId = task?.id;
  const liveText = task?.scratchpad;

  // Persist every store update (worker pushes on each scratchpad_update).
  useEffect(() => {
    if (!taskId) return;
    if (typeof liveText === "string" && liveText) {
      try {
        localStorage.setItem(KEY_PREFIX + taskId, liveText);
        localStorage.setItem(LAST_KEY, taskId);
      } catch {}
    }
  }, [taskId, liveText]);

  // Reload fallback: no live text (fresh boot, task done) → last persisted.
  useEffect(() => {
    if (liveText) return;
    try {
      const id = taskId ?? localStorage.getItem(LAST_KEY);
      if (!id) return;
      const saved = localStorage.getItem(KEY_PREFIX + id);
      if (saved) {
        setPersisted(saved);
        setPersistedTaskId(id);
      }
    } catch {}
  }, [taskId, liveText]);

  if (liveText) return { text: liveText, taskId: taskId ?? null, live: true };
  if (persisted) return { text: persisted, taskId: persistedTaskId, live: false };
  return { text: "", taskId: taskId ?? null, live: false };
}
