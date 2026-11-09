"use client";

import { useBackgroundChat } from "./useBackgroundChat";

/**
 * The agent's scratchpad for the Scratch panel: live text mirrored from the
 * background-task store. The store is the source of truth; this hook only
 * reflects it.
 *
 * DECISION D4 (right-panel-v2): the previous implementation mirrored every
 * update into localStorage per task and re-showed the last session's
 * read-only snapshot on reload. Per the v2 regression contract ("never
 * persisted, by design") that mirroring is gone — no task running means the
 * panel shows its empty copy.
 */
export function useScratchpad(): { text: string; taskId: string | null; live: boolean } {
  const { task } = useBackgroundChat();
  const text = task?.scratchpad ?? "";
  const status = task?.status;
  const live = text.length > 0 && status !== "done" && status !== "error" && status !== "idle";
  return { text, taskId: task?.id ?? null, live };
}
