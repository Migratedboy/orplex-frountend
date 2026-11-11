"use client";

/**
 * useNotificationCenter.ts — extracted verbatim from the old TopBar: same
 * /api/notifications feed, same badge, same fresh-arrival toasts, same
 * mark-read/clear-all contract. Consumed by the strip bell popover.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "@/lib/api-base";

export interface NotifItem {
  id: string;
  type: "info" | "success" | "error" | "warning" | string;
  title: string;
  message: string;
  source?: string;
  read: boolean;
  createdAt: string;
}

/** How long a freshly-arrived notification stays on screen before it
 *  "moves" to the bell icon. */
const TOAST_MS = 3_000;
/** Poll cadence for new notifications while the page is open. */
const POLL_MS = 15_000;

export function useNotificationCenter() {
  const [notifications, setNotifications] = useState<NotifItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [toasts, setToasts] = useState<NotifItem[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const since = useRef<string>(new Date(0).toISOString());
  const firstLoad = useRef(true);

  const poll = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/notifications?since=${encodeURIComponent(since.current)}`);
      if (!res.ok) return;
      const d = await res.json();
      const fresh: NotifItem[] = d.notifications || [];
      if (typeof d.unread === "number") setUnread(d.unread);
      if (fresh.length > 0) {
        since.current = fresh[0].createdAt;
        // Only toast what we haven't seen (and skip the initial backfill so
        // a page load doesn't replay old history as toasts).
        const arrivals = firstLoad.current ? [] : fresh.filter((n) => !seen.current.has(n.id));
        for (const n of fresh) seen.current.add(n.id);
        setNotifications((prev) => [...fresh.filter((n) => !prev.some((p) => p.id === n.id)), ...prev].slice(0, 100));
        if (arrivals.length > 0) {
          setToasts((prev) => [...arrivals, ...prev].slice(0, 3));
          for (const n of arrivals) {
            setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== n.id)), TOAST_MS);
          }
          // A woken model just became usable — tell the model picker to
          // refetch so it appears without reopening the menu.
          if (arrivals.some((n) => n.title === "Cold model woke up")) {
            window.dispatchEvent(new CustomEvent("orplex:wake-promoted"));
          }
        }
      }
      firstLoad.current = false;
    } catch {}
  }, []);

  useEffect(() => {
    poll();
    const iv = setInterval(poll, POLL_MS);
    return () => clearInterval(iv);
  }, [poll]);

  const markRead = useCallback(async (id?: string) => {
    try {
      const res = await apiFetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(id ? { id } : { all: true }),
      });
      if (!res.ok) return; // server rejected — keep local state truthful
      setNotifications((prev) => prev.map((n) => (!id || n.id === id ? { ...n, read: true } : n)));
      setUnread((u) => (id ? Math.max(0, u - 1) : 0));
    } catch {}
  }, []);

  const clearAll = useCallback(async () => {
    try {
      await apiFetch("/api/notifications", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      setNotifications([]);
      setUnread(0);
      seen.current.clear();
    } catch {}
  }, []);

  return { notifications, unread, toasts, markRead, clearAll };
}

export function notifIconGlyph(type: string) {
  if (type === "error") return "⛔";
  if (type === "success") return "✓";
  if (type === "warning") return "⚠";
  return "ℹ";
}

/** Shared feed type (one poller consumed by the bell + the toast stack). */
export type NotificationCenter = ReturnType<typeof useNotificationCenter>;
