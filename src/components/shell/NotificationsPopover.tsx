"use client";

/**
 * NotificationsPopover.tsx — the strip bell popover (spec §6.3). Source: the
 * same /api/notifications feed the old top bar used (useNotificationCenter).
 * Newest first, icon by type, one-line text, relative time; click marks read
 * and jumps to the chat/run; "Clear all". Unread badge caps at 9+.
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { useNotificationCenter, notifIconGlyph, type NotifItem, type NotificationCenter } from "./useNotificationCenter";

/** Shared feed instance — the Strip owns ONE poller; bell + toasts consume it. */
export type { NotificationCenter };

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function NotificationsPopover({ anchorRect, notif }: { anchorRect: DOMRect | null; notif: NotificationCenter }) {
  const { notifications, unread, markRead, clearAll } = notif;
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        // outside click is handled by the Strip (closes the popover)
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") window.dispatchEvent(new CustomEvent("orplex:close-popovers"));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const style: React.CSSProperties = {};
  if (anchorRect) {
    const width = 320;
    let left = anchorRect.left - width + anchorRect.width;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    style.left = left;
    style.top = anchorRect.bottom + 6;
  }

  return (
    <div className="ox-notif-pop" ref={ref} style={style} role="dialog" aria-label="Notification history">
      <div className="ox-notif-head">
        <span>Notifications{unread > 0 ? ` (${unread})` : ""}</span>
        {notifications.length > 0 && (
          <button onClick={() => void clearAll()}>Clear all</button>
        )}
      </div>
      {notifications.length === 0 ? (
        <div className="ox-notif-empty">You&rsquo;re all caught up.</div>
      ) : (
        <div className="ox-notif-list">
          {notifications.map((n: NotifItem) => (
            <div
              key={n.id}
              className={`ox-notif-item ${n.read ? "" : "unread"}`}
              onClick={() => { if (!n.read) void markRead(n.id); }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" && !n.read) void markRead(n.id); }}
            >
              <span className="ox-ni-ic" aria-hidden="true">{notifIconGlyph(n.type)}</span>
              <div className="ox-ni-body">
                <div className="ox-ni-title">{n.title}</div>
                {n.message ? <div className="ox-ni-msg">{n.message}</div> : null}
                <div className="ox-ni-time">{relTime(n.createdAt)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function BellButton({ notif }: { notif: NotificationCenter }) {
  const { unread } = notif;
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      const pop = document.querySelector(".ox-notif-pop");
      if (pop?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDown, { passive: true });
    window.addEventListener("orplex:close-popovers", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("orplex:close-popovers", close);
    };
  }, [open]);

  const toggle = () => {
    if (!open && btnRef.current) setRect(btnRef.current.getBoundingClientRect());
    setOpen((v) => !v);
  };

  return (
    <>
      <button ref={btnRef} className="ox-bell" onClick={toggle} aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`} aria-expanded={open} aria-haspopup="dialog">
        <Icon name="bell" size={15} />
        {unread > 0 && (
          <span
            style={{
              position: "absolute", top: 0, right: -1, minWidth: 15, height: 15, padding: "0 3px",
              borderRadius: 999, background: "var(--accent)", color: "#1b1206", fontSize: 9.5,
              fontWeight: 700, lineHeight: "15px", textAlign: "center", pointerEvents: "none",
            }}
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && <NotificationsPopover anchorRect={rect} notif={notif} />}
    </>
  );
}

/** Fresh-arrival toast stack (top-right) — same feed, verbatim behavior. */
export function NotifToasts({ notif }: { notif: NotificationCenter }) {
  if (notif.toasts.length === 0) return null;
  return (
    <div className="ox-notif-toasts" role="status" aria-live="polite">
      {notif.toasts.map((n: NotifItem) => (
        <div key={n.id} className="ox-notif-toast" data-type={n.type}>
          <div className="ox-nt-title">
            <span aria-hidden="true">{notifIconGlyph(n.type)}</span>
            {n.title}
          </div>
          {n.message ? <div className="ox-nt-msg">{n.message}</div> : null}
        </div>
      ))}
    </div>
  );
}
