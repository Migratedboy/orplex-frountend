"use client";

/**
 * QueueTab.tsx — the Queue tab of the right panel: what the agent is doing
 * now. Right Panel v2 (P2):
 * - Reference presentation: status circle (ok/err/run icon), message,
 *   status text with animated dots while running.
 * - Q2: click a row → jump to its conversation (router push + announce, the
 *   documented navigation-events pattern).
 * - Q3: a running row offers Stop via the existing abort path.
 */
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useBackgroundChat } from "@/hooks/useBackgroundChat";
import { abortCurrentTask } from "@/lib/background-chat";
import { announceConversationOpen } from "@/lib/navigation-events";
import { QueuePanelSkeleton } from "../PanelSkeletons";
import { IconCheck, IconX, IconPlay, IconStop } from "../Icons";

type QState = "ok" | "err" | "run";

function stateOf(status: string): QState {
  if (status === "done") return "ok";
  if (status === "error") return "err";
  return "run";
}

const Q_ICON: Record<QState, (p: { size?: number }) => React.ReactNode> = {
  ok: IconCheck,
  err: IconX,
  run: IconPlay,
};

export function QueueTab() {
  const { task } = useBackgroundChat();
  const router = useRouter();

  // Skeleton only while the first read is in flight. useBackgroundChat starts
  // with task === undefined, which is indistinguishable from "no task" — showing
  // the skeleton on a genuine no-task state would leave it spinning forever, so
  // the skeleton is confined to the very first paint.
  const firstPaint = useRef(true);
  useEffect(() => { firstPaint.current = false; }, []);
  if (!task && firstPaint.current) return <QueuePanelSkeleton />;
  if (!task) {
    return (
      <div className="rp-v2-queue">
        <div className="rp-v2-q-empty">No active tasks</div>
      </div>
    );
  }

  const st = stateOf(task.status);
  const Icon = Q_ICON[st];
  const running = st === "run";

  const jumpTo = () => {
    if (!task.conversationId) return;
    router.push(`/?c=${task.conversationId}`);
    announceConversationOpen(task.conversationId);
  };

  return (
    <div className="rp-v2-queue">
      <div
        className="rp-v2-qi"
        role={task.conversationId ? "link" : undefined}
        tabIndex={task.conversationId ? 0 : undefined}
        title={task.conversationId ? "Jump to conversation" : undefined}
        onClick={jumpTo}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && task.conversationId) {
            e.preventDefault();
            jumpTo();
          }
        }}
      >
        <span className={`rp-v2-qs ${st}`} aria-hidden="true"><Icon size={11} /></span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="rp-v2-qm">{task.userMessage}</div>
          <div className={`rp-v2-qt ${running ? "dots" : ""}`}>{task.statusDetail || task.status}</div>
        </div>
        {running && (
          <button
            className="rp-v2-q-stop"
            title="Stop this task"
            aria-label="Stop this task"
            onClick={(e) => {
              e.stopPropagation();
              abortCurrentTask();
            }}
          >
            <IconStop size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
