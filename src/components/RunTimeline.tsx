"use client";

import { useEffect, useRef, useState } from "react";
import { describeEvent } from "@/lib/board-format";
import { apiFetch } from "@/lib/api-base";

// RunTimeline — the mission-control event stream. Polls the sequence-cursor
// events API and renders each lifecycle event with a type icon and delta
// timestamp, newest-last with the viewport pinned to the tail while live.
//
// The cursor discipline: never re-derive from timestamps. `after` is the last
// sequence we rendered; every poll asks only for what's newer, so events can
// neither be missed nor double-shown even when polls overlap or the DB is
// mid-append.

export interface TimelineEvent {
  sequence: number;
  type: string;
  label?: string | null;
  detail?: string | null;
  payload?: unknown;
  createdAt: string;
}

const EVENT_STYLE: Record<string, { icon: string; tone: string }> = {
  run_created: { icon: "play_circle", tone: "text-on-surface-variant" },
  spawned: { icon: "play_circle", tone: "text-on-surface-variant" },
  claimed: { icon: "play_arrow", tone: "text-blue-500" },
  "worktree-created": { icon: "call_split", tone: "text-purple-500" },
  "approval-requested": { icon: "pause_circle", tone: "text-amber-500" },
  "approval-granted": { icon: "check_circle", tone: "text-emerald-500" },
  "approval-denied": { icon: "block", tone: "text-red-400" },
  "run-finished": { icon: "stop_circle", tone: "text-emerald-500" },
  "run-failed": { icon: "stop_circle", tone: "text-red-500" },
  "branch-pushed": { icon: "north", tone: "text-cyan-600" },
  "pr-opened": { icon: "merge", tone: "text-cyan-500" },
  usage: { icon: "functions", tone: "text-on-surface-variant" },
  "usage-total": { icon: "functions", tone: "text-emerald-600" },
  "provider-failover": { icon: "swap_horiz", tone: "text-amber-600" },
  "native-tools-unsupported": { icon: "warning", tone: "text-amber-500" },
  "requeued-after-restart": { icon: "restart_alt", tone: "text-amber-500" },
  compacted: { icon: "compress", tone: "text-on-surface-variant" },
  "mcp-tools-loaded": { icon: "extension", tone: "text-purple-500" },
  "mcp-server-error": { icon: "error", tone: "text-red-400" },
  "tool-denied": { icon: "block", tone: "text-red-400" },
  "tool-notify": { icon: "notifications", tone: "text-amber-500" },
  "verify-repaired": { icon: "build", tone: "text-amber-500" },
  "checkpoint-created": { icon: "history", tone: "text-cyan-600" },
  "checkpoint-restored": { icon: "restore", tone: "text-amber-600" },
  "artifact-review": { icon: "fact_check", tone: "text-emerald-600" },
  "artifact-chain-approved": { icon: "done_all", tone: "text-emerald-500" },
  task: { icon: "radio_button_unchecked", tone: "text-on-surface-variant" },
  plan: { icon: "format_list_bulleted", tone: "text-blue-400" },
  verify: { icon: "verified", tone: "text-cyan-500" },
  default: { icon: "circle", tone: "text-on-surface-variant" },
};

function eventStyle(type: string) {
  return EVENT_STYLE[type] || EVENT_STYLE.default;
}

export default function RunTimeline({
  runId,
  active,
}: {
  runId: string;
  active: boolean;
}) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const cursorRef = useRef(0);
  const tailRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    cursorRef.current = -1; // initial fetch includes sequence 0 (`spawned`)
    setEvents([]);

    const poll = async () => {
      try {
        const res = await apiFetch(`/api/agent/runs/${runId}/events?after=${cursorRef.current}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !data.success) return;
        const incoming: TimelineEvent[] = data.events || [];
        if (incoming.length > 0) {
          cursorRef.current = data.cursor;
          setEvents((prev) => [...prev, ...incoming]);
        }
      } catch {
        // transient network/DB error — next poll retries with the same cursor
      }
    };

    poll();
    if (active) {
      const interval = setInterval(poll, 2000);
      return () => {
        cancelled = true;
        clearInterval(interval);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [runId, active]);

  // Pin the tail while active: new events stay visible without scrolling.
  useEffect(() => {
    if (active && tailRef.current) {
      tailRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [events, active]);

  if (events.length === 0) {
    return (
      <div className="text-[11px] font-mono text-on-surface-variant py-3 px-1">
        {active ? "waiting for events…" : "no events recorded"}
      </div>
    );
  }

  const first = events[0];

  return (
    <div className="run-timeline flex flex-col gap-1 max-h-64 overflow-y-auto py-1">
      {events.map((ev, i) => {
        const { icon, tone } = eventStyle(ev.type);
        const prev = i > 0 ? events[i - 1] : null;
        const gapStart = prev
          ? Math.round((new Date(ev.createdAt).getTime() - new Date(prev.createdAt).getTime()) / 1000)
          : 0;
        const delta = i === 0 ? 0 : gapStart;
        return (
          <div key={ev.sequence} className="flex items-baseline gap-2 text-[11px] font-mono leading-relaxed">
            <span className="text-on-surface-variant/50 w-10 text-right shrink-0" title={ev.createdAt}>
              {i === 0
                ? new Date(first.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                : `+${delta}s`}
            </span>
            <span className={`shrink-0 ${tone}`}><span className="ms ms-sm">{icon}</span></span>
            <span className="text-on-surface-variant shrink-0">{ev.type}</span>
            {(() => {
              // Prefer a derived human label from the raw payload (executor
              // events); fall back to whatever the runtime event carried.
              const derived = describeEvent(ev.type, ev.payload);
              const label = derived?.label ?? ev.label;
              const detail = derived?.detail ?? ev.detail;
              return (label || detail) ? (
                <span className="truncate" title={detail || label || ""}>
                  {label}
                  {label && detail ? " — " : ""}
                  {detail}
                </span>
              ) : null;
            })()}
            {/* Checkpoint restore affordance — rewind the workspace to this point */}
            {ev.type === "checkpoint-created" && runId && (
              <button
                type="button"
                className="ml-auto shrink-0 text-[10px] font-sans font-semibold text-cyan-600 hover:text-cyan-500 border border-cyan-600/30 hover:border-cyan-500 rounded px-2 py-0.5"
                title="Restore the workspace to this checkpoint (events after it are archived, never destroyed)"
                onClick={() => void restoreCheckpoint(ev)}
              >
                rewind
              </button>
            )}
            {/* Auto-checkpoint badge — taken by the gate before an agent write */}
            {ev.type === "checkpoint-created" &&
              (ev.payload as { auto?: boolean } | null)?.auto === true && (
                <span
                  className="shrink-0 text-[9px] font-sans font-bold uppercase tracking-wide text-cyan-700 bg-cyan-500/10 border border-cyan-600/20 rounded px-1.5 py-0.5"
                  title="Taken automatically before an agent file write (cooldown + per-run cap + RAM guard)"
                >
                  auto
                </span>
              )}
          </div>
        );
      })}
      <div ref={tailRef} />
    </div>
  );

  async function restoreCheckpoint(ev: TimelineEvent) {
    const payload = (ev.payload || {}) as { sequence?: number };
    if (typeof payload.sequence !== "number") return;
    if (!window.confirm("Rewind the workspace to this checkpoint? Events after it are archived, not deleted.")) return;
    try {
      const res = await apiFetch(`/api/agent/checkpoints`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, sequence: payload.sequence }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        window.alert(`Rewind failed: ${data.error || res.status}`);
      }
    } catch {
      window.alert("Rewind failed: network error");
    }
  }
}
