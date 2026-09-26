"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-base";

// RunLiveStatus — the live cell on a Manager board lane. For active runs it
// polls the sequence-cursor events feed and shows the latest lifecycle event
// plus an elapsed timer, so the board reads as mission control rather than a
// stale list. Only mounted for active runs — finished runs cost nothing.

interface LatestEvent {
  type: string;
  detail: string | null;
}

export default function RunLiveStatus({
  runId,
  startedAt,
}: {
  runId: string;
  startedAt: string;
}) {
  const [latest, setLatest] = useState<LatestEvent | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // 1s clock for the elapsed timer.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Cursor-disciplined event poll (same contract as RunTimeline).
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let cursor = 0;
    const poll = async () => {
      try {
        const res = await apiFetch(`/api/agent/runs/${runId}/events?after=${cursor}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !data.success) return;
        const events = Array.isArray(data.events) ? data.events : [];
        if (events.length > 0) {
          cursor = data.cursor;
          const last = events[events.length - 1];
          setLatest({ type: String(last.type), detail: (last.detail || last.label || null) as string | null });
        }
      } catch {
        // transient — next poll retries with the same cursor
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [runId]);

  const elapsed = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const mm = Math.floor(elapsed / 60);
  const ss = elapsed % 60;

  return (
    <span
      className="board-lane-live"
      title={latest?.detail || latest?.type || "waiting for events"}
    >
      <span className="board-lane-live-dot" />
      {latest ? latest.type : "starting…"}
      <span className="board-lane-live-time">
        {mm}:{String(ss).padStart(2, "0")}
      </span>
    </span>
  );
}
