"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-base";
import { OPEN_CONVERSATION_EVENT } from "@/lib/navigation-events";

export const CHAT_SENT_EVENT = "orplex:chat-sent";

export default function QuotaIndicator() {
  const [quota, setQuota] = useState<{ remaining: number; limit: number } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await apiFetch("/api/user/quota");
      const data = await r.json();
      if (data && typeof data.remaining === "number" && typeof data.limit === "number") setQuota(data);
    } catch {}
  }, []);

  useEffect(() => {
    void refresh();
    // The backend counts the request before the first token streams back, so
    // a short delay lands this refresh after the increment is committed.
    const onSent = () => {
      setTimeout(() => { void refresh(); }, 1500);
    };
    window.addEventListener(CHAT_SENT_EVENT, onSent);
    window.addEventListener(OPEN_CONVERSATION_EVENT, onSent);
    // A slow poll papers over any path that skips the events (panel actions,
    // background workers) — 60s keeps the needle honest without spamming.
    const poll = setInterval(() => { void refresh(); }, 60_000);
    return () => {
      window.removeEventListener(CHAT_SENT_EVENT, onSent);
      window.removeEventListener(OPEN_CONVERSATION_EVENT, onSent);
      window.clearInterval(poll);
    };
  }, [refresh]);

  if (!quota) return null;

  const used = quota.limit - quota.remaining;
  const percent = quota.limit > 0 ? (used / quota.limit) * 100 : 0;
  // Thresholds: amber warns at 80%, red only becomes urgent at 95%.
  const fill = percent >= 95 ? "#ef4444" : percent >= 80 ? "#f59e0b" : "#22c55e";

  return (
    <div className="quota-indicator">
      <span className="quota-text">{used}/{quota.limit} requests today</span>
      <div className="quota-bar" role="meter" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100} aria-label="Daily request usage">
        <div className="quota-fill" style={{ width: `${Math.min(100, percent)}%`, background: fill }} />
      </div>
    </div>
  );
}
