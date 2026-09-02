"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useTheme } from "@/components/ThemeProvider";
import { useRouter } from "next/navigation";
import { IconSearch, IconBug, IconSun, IconMoon, IconBell } from "./Icons";

interface SearchResult { id: string; title: string; messages: { content: string }[]; }
interface Notification { id: string; message: string; type: string; read: boolean; createdAt: string; }

export default function TopBar({ title = "Orplex Tech", onBugReport, onTogglePanel, panelOpen }: { title?: string; onBugReport?: () => void; onTogglePanel?: () => void; panelOpen?: boolean }) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showNotifs, setShowNotifs] = useState(false);
  const { dark, toggle } = useTheme();
  const router = useRouter();
  const searchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cached = sessionStorage.getItem("notifications");
    if (cached) {
      try { setNotifications(JSON.parse(cached)); } catch {}
    }
    fetch("/api/notifications").then(r => r.json()).then(d => {
      const notifs = d.notifications || [];
      setNotifications(notifs);
      sessionStorage.setItem("notifications", JSON.stringify(notifs));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!search.trim()) { setResults([]); return; }
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(search)}`).then(r => r.json()).then(d => setResults(d.results || [])).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => { if (searchRef.current && !searchRef.current.contains(e.target as Node)) setShowResults(false); };
    document.addEventListener("mousedown", handleClick, { passive: true });
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleSearchResultClick = useCallback((id: string) => {
    router.push(`/?c=${id}`);
    setShowResults(false);
    setSearch("");
  }, [router]);

  const unread = notifications.filter(n => !n.read).length;

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
            <span style={{ fontSize: 14, fontWeight: 700 }}>{panelOpen ? "]" : "["}</span>
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
        <div className="relative">
          <button onClick={() => setShowNotifs(!showNotifs)} className="topbar-icon-btn" aria-label="Notifications" aria-expanded={showNotifs}>
            <IconBell size={16} />
            {unread > 0 && <span className="notif-badge">{unread}</span>}
          </button>
          {showNotifs && (
            <div className="notif-dropdown">
              <div className="notif-dropdown-header">Notifications</div>
              {notifications.length === 0 ? (
                <div className="notif-dropdown-empty">No notifications</div>
              ) : notifications.map(n => (
                <div key={n.id} className="notif-dropdown-item">
                  <p className="notif-dropdown-msg">{n.message}</p>
                  <p className="notif-dropdown-time">{new Date(n.createdAt).toLocaleString()}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
