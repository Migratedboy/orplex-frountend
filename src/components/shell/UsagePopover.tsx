"use client";

/**
 * UsagePopover.tsx — hover/focus card on the rail avatar (spec §6.2): a
 * 230px card anchored to the rail's right edge, bottom aligned near the
 * avatar, clamped to the viewport. Data = the SAME quota source as the
 * sidebar meter (/api/user/quota, refreshed on orplex:chat-sent).
 */
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-base";
import { CHAT_SENT_EVENT } from "@/components/QuotaIndicator";
import { OPEN_CONVERSATION_EVENT } from "@/lib/navigation-events";

interface Quota { used: number; limit: number }

export function useDailyQuota(): Quota | null {
  const [quota, setQuota] = useState<Quota | null>(null);
  useEffect(() => {
    const refresh = async () => {
      try {
        const r = await apiFetch("/api/user/quota");
        const data = (await r.json()) as { remaining?: number; limit?: number };
        if (typeof data.remaining === "number" && typeof data.limit === "number") {
          setQuota({ used: data.limit - data.remaining, limit: data.limit });
        }
      } catch {}
    };
    void refresh();
    const onSent = () => { setTimeout(() => { void refresh(); }, 1500); };
    window.addEventListener(CHAT_SENT_EVENT, onSent);
    window.addEventListener(OPEN_CONVERSATION_EVENT, onSent);
    const poll = setInterval(() => { void refresh(); }, 60_000);
    return () => {
      window.removeEventListener(CHAT_SENT_EVENT, onSent);
      window.removeEventListener(OPEN_CONVERSATION_EVENT, onSent);
      clearInterval(poll);
    };
  }, []);
  return quota;
}

export function UsagePopover({ visible, anchor }: { visible: boolean; anchor: HTMLElement | null }) {
  const quota = useDailyQuota();
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!visible || !anchor || !ref.current) return;
    const a = anchor.getBoundingClientRect();
    const h = ref.current.offsetHeight;
    setPos({
      left: a.right + 6,
      top: Math.max(8, Math.min(window.innerHeight - h - 8, a.bottom - h + 8)),
    });
  }, [visible, anchor, quota]);

  const pct = quota && quota.limit > 0 ? Math.min(100, Math.round((quota.used / quota.limit) * 100)) : 0;

  return (
    <div
      ref={ref}
      className={`ox-usage-pop ${visible ? "show" : ""}`}
      role="tooltip"
      id="ox-usage-pop"
      style={pos ? { left: pos.left, top: pos.top } : undefined}
      aria-hidden={!visible}
    >
      <div className="ox-top"><span>Daily</span><span>{pct}% used</span></div>
      <div className="ox-bar"><i style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
