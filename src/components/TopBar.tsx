"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useTheme } from "@/components/ThemeProvider";
import { useRouter } from "next/navigation";
import { announceConversationOpen } from "@/lib/navigation-events";
import { IconSearch, IconBug, IconSun, IconMoon, IconBell, IconPanel } from "./Icons";
import { apiFetch } from "@/lib/api-base";

interface SearchResult { id: string; title: string; messages: { content: string }[]; }
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
      await apiFetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(id ? { id } : { all: true }),
      });
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

function notifIcon(type: string) {
  if (type === "error") return "⛔";
  if (type === "success") return "✓";
  if (type === "warning") return "⚠";
  return "ℹ";
}

export default function TopBar({ title = "Orplex Tech", onBugReport, onTogglePanel, panelOpen }: { title?: string; onBugReport?: () => void; onTogglePanel?: () => void; panelOpen?: boolean }) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [showNotifs, setShowNotifs] = useState(false);
  const { dark, toggle } = useTheme();
  const router = useRouter();
  const searchRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const { notifications, unread, toasts, markRead, clearAll } = useNotificationCenter();

  useEffect(() => {
    if (!search.trim()) { setResults([]); return; }
    const t = setTimeout(() => {
      apiFetch(`/api/search?q=${encodeURIComponent(search)}`).then(r => r.json()).then(d => setResults(d.results || [])).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setShowResults(false);
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setShowNotifs(false);
    };
    document.addEventListener("mousedown", handleClick, { passive: true });
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleSearchResultClick = useCallback((id: string) => {
    router.push(`/?c=${id}`);
    // SPA push doesn't remount '/' — tell the mounted hook to load it.
    announceConversationOpen(id);
    setShowResults(false);
    setSearch("");
  }, [router]);

  return (
    <header className="topbar-header">
      <div className="topbar-left">
        <h1 className="topbar-title">{title}</h1>
      </div>
      <div className="topbar-actions">
        <div className="topbar-search" ref={searchRef}>
          <IconSearch size={14} className="topbar-search-icon" />
          <input
            className="topbar-search-input"
            placeholder="Search conversations… (Ctrl+K)"
            aria-label="Search conversations"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setShowResults(true); }}
            onFocus={() => setShowResults(true)}
          />
          {showResults && results.length > 0 && (
            <div className="topbar-search-results">
              {results.map((r) => (
                <div key={r.id} className="topbar-search-result-item" onClick={() => handleSearchResultClick(r.id)}>
                  <div className="topbar-search-result-title">{r.title}</div>
                  <div className="topbar-search-result-snippet">{r.messages?.[0]?.content || ""}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        {onTogglePanel && (
          <button onClick={onTogglePanel} className={`topbar-icon-btn ${panelOpen ? "topbar-panel-active" : ""}`} title="Toggle right panel" aria-label="Toggle right panel">
            <span
              style={{
                display: "inline-flex",
                transform: panelOpen ? "none" : "scaleX(-1)",
              }}
            >
              <IconPanel size={16} />
            </span>
          </button>
        )}
        {onBugReport && (
          <button onClick={onBugReport} className="topbar-btn topbar-bug-btn">
            <IconBug size={14} /> <span className="topbar-btn-label">Report Bug</span>
          </button>
        )}
        <button onClick={toggle} className="topbar-icon-btn" title={dark ? "Light Mode" : "Dark Mode"} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>
          {dark ? <IconSun size={16} /> : <IconMoon size={16} />}
        </button>
        {/* Notification center: fresh items toast for 3s, then live here
            behind the bell with a persistent unread badge. */}
        <div className="relative" ref={notifRef}>
          <button
            onClick={() => { setShowNotifs(v => !v); if (!showNotifs) void markRead(); }}
            className="topbar-icon-btn"
            aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
            aria-expanded={showNotifs}
            title={unread ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "Notifications"}
          >
            <IconBell size={16} />
            {unread > 0 && <span className="notif-badge">{unread > 99 ? "99+" : unread}</span>}
          </button>
          {showNotifs && (
            <div className="notif-dropdown" role="dialog" aria-label="Notification history">
              <div className="notif-dropdown-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Notifications</span>
                {notifications.length > 0 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); void clearAll(); }}
                    style={{ background: "none", border: "none", color: "#9ca3af", fontSize: 10, cursor: "pointer", padding: 0 }}
                    title="Clear all notifications"
                  >
                    Clear all
                  </button>
                )}
              </div>
              {notifications.length === 0 ? (
                <div className="notif-dropdown-empty">No notifications</div>
              ) : (
                <div style={{ maxHeight: 340, overflowY: "auto" }}>
                  {notifications.map((n) => (
                    <div
                      key={n.id}
                      className={`notif-dropdown-item ${n.read ? "" : "notif-dropdown-item-unread"}`}
                      onClick={() => void markRead(n.id)}
                      style={{ cursor: "pointer", borderLeft: n.read ? undefined : "2px solid #f97316" }}
                      title={n.read ? undefined : "Mark as read"}
                    >
                      <p className="notif-dropdown-msg">
                        <span style={{ marginRight: 6 }} aria-hidden="true">{notifIcon(n.type)}</span>
                        <b style={{ fontWeight: 600 }}>{n.title}</b>
                        {n.message ? <span style={{ display: "block", opacity: 0.8, marginTop: 2 }}>{n.message}</span> : null}
                      </p>
                      <p className="notif-dropdown-time">{new Date(n.createdAt).toLocaleString()}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {/* Fresh-arrival toasts: visible 3s, then the item remains in the bell. */}
      {toasts.length > 0 && (
        <div className="topbar-notif-toasts" role="status" aria-live="polite" style={{ position: "fixed", top: 52, right: 16, zIndex: 90, display: "flex", flexDirection: "column", gap: 8 }}>
          {toasts.map((n) => (
            <div
              key={n.id}
              className="topbar-notif-toast"
              style={{
                minWidth: 280,
                maxWidth: 380,
                padding: "10px 14px",
                borderRadius: 10,
                background: n.type === "error" ? "#7f1d1d" : n.type === "success" ? "#14532d" : "#1e293b",
                color: "#f9fafb",
                boxShadow: "0 8px 24px rgba(0,0,0,.35)",
                border: `1px solid ${n.type === "error" ? "#b91c1c" : n.type === "success" ? "#166534" : "#334155"}`,
                fontSize: 12.5,
                lineHeight: 1.45,
              }}
            >
              <div style={{ fontWeight: 600, display: "flex", gap: 6, alignItems: "center" }}>
                <span aria-hidden="true">{notifIcon(n.type)}</span>
                {n.title}
              </div>
              {n.message ? <div style={{ opacity: 0.85, marginTop: 2 }}>{n.message}</div> : null}
            </div>
          ))}
        </div>
      )}
    </header>
  );
}
