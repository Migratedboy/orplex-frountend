"use client";

/* Sidebar.tsx — file-system rail, ported from orplex-sidebar-react.html.
   Everything reads from the real app: next-auth session, ConversationProvider
   chats, WorkspaceProvider projects, ThemeProvider, /api/user/quota, and the
   FileSystem folder picker. No demo data, no orp.* keys, no window.prompt.
   Mounted by AppLayout (dynamic, ssr:false); collapse is driven by
   AppLayout's `orplex.sidebarCollapsed` via the `orplex:toggle-sidebar`
   event this component dispatches. */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { useConversations } from "./ConversationProvider";
import { useWorkspace } from "./WorkspaceProvider";
import { useFileSystemContext } from "./FileSystemProvider";
import { useTheme } from "./ThemeProvider";
import { useActiveRunCount } from "@/hooks/useActiveRunCount";
import { useToast } from "@/components/Toast";
import { useBackgroundChat } from "@/hooks/useBackgroundChat";
import { announceConversationOpen } from "@/lib/navigation-events";
import { apiFetch } from "@/lib/api-base";
import { CHAT_SENT_EVENT } from "./QuotaIndicator";
import { OPEN_CONVERSATION_EVENT } from "@/lib/navigation-events";
import {
  forkConversation,
  isLocalConversationMode,
} from "@/lib/conversations-transport";
import { projectLabel } from "@/lib/project-threads";
import styles from "./Sidebar.module.css";

/* ---- icons (exact path set from the design file) ---- */
const PATHS: Record<string, string> = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  newchat: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a1 1 0 0 1 3 3l-9 9a2 2 0 0 1-.9.5l-2.9.8a.5.5 0 0 1-.6-.6l.8-2.9a2 2 0 0 1 .5-.9z"/>',
  newproj: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/><path d="M12 10v6M9 13h6"/>',
  flow: '<rect x="3" y="3" width="8" height="8" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect x="13" y="13" width="8" height="8" rx="2"/>',
  board: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 7v7M12 7v4M16 7v9"/>',
  plug: '<path d="M12 22v-5M9 8V2M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>',
  mem: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  gear: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
  folderopen: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.2 10H20a2 2 0 0 1 1.9 2.5l-1.5 6a2 2 0 0 1-1.9 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H18a2 2 0 0 1 2 2v2"/>',
  chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/>',
  branch: '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  chev: '<path d="m9 18 6-6-6-6"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  edit: '<path d="M12 20h9"/><path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
};

function Icon({ n, className = "" }: { n: string; className?: string }) {
  return (
    <svg
      className={`${styles.i} ${className}`}
      viewBox="0 0 24 24"
      dangerouslySetInnerHTML={{ __html: PATHS[n] ?? "" }}
    />
  );
}

const W = ({ t, c = "" }: { t: string; c?: string }) => (
  <span className={`${styles.w} ${c}`} data-t={t}>{t}</span>
);

function Hl({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

interface ChatLike {
  id: string;
  title: string;
  workspaceName?: string | null;
}

function NavRow({
  icon, label, active, onClick, badge,
}: {
  icon: string; label: string; active?: boolean; onClick: () => void; badge?: ReactNode;
}) {
  return (
    <button className={`${styles.row} ${active ? styles.active : ""}`} onClick={onClick}>
      <Icon n={icon} /><span className={styles.lbl}>{label}</span>
      {badge}
    </button>
  );
}

function ChatRow({
  chat, q, active, menuOpen, renaming, onSelect, onMenu, onRename, onHover,
}: {
  chat: ChatLike; q: string; active: boolean; menuOpen: boolean; renaming: boolean;
  onSelect: (id: string) => void; onMenu: (id: string, x: number, y: number) => void;
  onRename: (id: string, t: string) => void;
  onHover: (chat: ChatLike | null, rect?: DOMRect) => void;
}) {
  const [val, setVal] = useState(chat.title);
  // Real fork marker: the local store appends " (fork)" once (conversations-store).
  const isFork = chat.title.endsWith(" (fork)");
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") onRename(chat.id, val.trim() || chat.title);
    if (e.key === "Escape") onRename(chat.id, chat.title);
  };
  return (
    <div
      className={`${styles.row} ${active ? styles.active : ""} ${menuOpen ? styles.menu : ""}`}
      tabIndex={0} role="button"
      onClick={() => !renaming && onSelect(chat.id)}
      onKeyDown={(e) => e.key === "Enter" && !renaming && onSelect(chat.id)}
      onContextMenu={(e) => { e.preventDefault(); onMenu(chat.id, e.clientX, e.clientY); }}
      onMouseEnter={(e) => onHover(chat, e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => onHover(null)}
    >
      <Icon n="chat" />
      {renaming
        ? <input autoFocus value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={key}
            onBlur={() => onRename(chat.id, val.trim() || chat.title)} onClick={(e) => e.stopPropagation()} aria-label="Chat title" />
        : <span className={styles.lbl}><Hl text={chat.title} q={q} /></span>}
      {!renaming && isFork && <Icon n="branch" className={styles.br} />}
      {!renaming && (
        <button className={styles.more} aria-label="Chat actions"
          onClick={(e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); onMenu(chat.id, b.left, b.bottom + 4); }}>
          <Icon n="dots" />
        </button>
      )}
    </div>
  );
}

function ChatMenu({
  pos, chat, onAct, onClose,
}: {
  pos: { x: number; y: number }; chat: ChatLike;
  onAct: (act: string) => void; onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("blur", close); };
  }, [onClose]);
  const x = Math.min(pos.x, window.innerWidth - 190), y = Math.min(pos.y, window.innerHeight - 170);
  const canFork = isLocalConversationMode();
  return (
    <div className={styles.menu} style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
      <button onClick={() => onAct("rename")}><Icon n="edit" />Rename</button>
      <button onClick={() => onAct("fork")} disabled={!canFork} title={canFork ? undefined : "Fork is available in the desktop app"}><Icon n="branch" />Fork chat</button>
      <button className={styles.del} onClick={() => onAct("delete")}><Icon n="trash" />Delete</button>
    </div>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, status } = useSession();
  const { conversations, renameConversation, deleteConversation, refresh } = useConversations();
  const { projects } = useWorkspace();
  const { openFolder, reopenProject, attachPath, directoryName } = useFileSystemContext();
  const { toast } = useToast();
  const { dark, toggle: toggleTheme } = useTheme();
  const { activeRuns, pendingApprovals } = useActiveRunCount();
  const { task, isRunning } = useBackgroundChat();

  const [width, setWidth] = useState(272);
  const [drag, setDrag] = useState(false);
  const [searchOn, setSearchOn] = useState(false);
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [tip, setTip] = useState<{ chat: ChatLike; rect: DOMRect } | null>(null);
  const [openProjects, setOpenProjects] = useState<Set<string>>(new Set());
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [chatsOpen, setChatsOpen] = useState(true);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [quota, setQuota] = useState<{ used: number; limit: number } | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Width + open-project state persist in the app's own keys (never orp.*).
  useEffect(() => {
    try {
      const w = Number(localStorage.getItem("orplex.sidebarWidth"));
      if (Number.isFinite(w) && w >= 220 && w <= 420) {
        setWidth(w);
        // TopBar is position:fixed — its left offset tracks the rail width.
        document.documentElement.style.setProperty("--sb-w", `${w}px`);
      }
      const open = JSON.parse(localStorage.getItem("orplex.sidebarOpenProjects") ?? "[]") as unknown;
      if (Array.isArray(open)) setOpenProjects(new Set(open.filter((x): x is string => typeof x === "string")));
      setProjectsOpen(localStorage.getItem("orplex.sidebarProjectsOpen.v2") !== "0");
      setChatsOpen(localStorage.getItem("orplex.sidebarChatsOpen.v2") !== "0");
    } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem("orplex.sidebarOpenProjects", JSON.stringify([...openProjects])); } catch {}
  }, [openProjects]);
  useEffect(() => {
    try { localStorage.setItem("orplex.sidebarProjectsOpen.v2", projectsOpen ? "1" : "0"); } catch {}
  }, [projectsOpen]);
  useEffect(() => {
    try { localStorage.setItem("orplex.sidebarChatsOpen.v2", chatsOpen ? "1" : "0"); } catch {}
  }, [chatsOpen]);

  // Active chat follows the ?c= query (same contract as TopBar/History).
  useEffect(() => {
    const read = () => setActiveChatId(new URLSearchParams(window.location.search).get("c"));
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, [pathname]);

  // Quota meter (same endpoint + live events as QuotaIndicator).
  useEffect(() => {
    const refreshQuota = async () => {
      try {
        const r = await apiFetch("/api/user/quota");
        const data = (await r.json()) as { remaining?: number; limit?: number };
        if (typeof data.remaining === "number" && typeof data.limit === "number") {
          setQuota({ used: data.limit - data.remaining, limit: data.limit });
        }
      } catch {}
    };
    void refreshQuota();
    const onSent = () => { setTimeout(() => { void refreshQuota(); }, 1500); };
    window.addEventListener(CHAT_SENT_EVENT, onSent);
    window.addEventListener(OPEN_CONVERSATION_EVENT, onSent);
    const poll = setInterval(() => { void refreshQuota(); }, 60_000);
    return () => {
      window.removeEventListener(CHAT_SENT_EVENT, onSent);
      window.removeEventListener(OPEN_CONVERSATION_EVENT, onSent);
      clearInterval(poll);
    };
  }, []);

  // Search toggle shortcut lives in AppLayout (Ctrl+K opens the palette);
  // Escape collapses search/menu here.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
        if (searchOn) { setSearchOn(false); setQ(""); }
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [searchOn]);

  const onHover = useCallback((chat: ChatLike | null, rect?: DOMRect) => {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    if (!chat || !rect) return setTip(null);
    tipTimer.current = setTimeout(() => setTip({ chat, rect }), 350);
  }, []);

  const loadConversation = (id: string) => {
    router.push(`/?c=${encodeURIComponent(id)}`);
    announceConversationOpen(id);
    setMobileOpen(false);
  };

  const newChat = () => {
    router.push("/");
    window.dispatchEvent(new CustomEvent("orplex:new-chat"));
    setMobileOpen(false);
  };

  const toggleProject = (name: string) => {
    setOpenProjects((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const rename = async (id: string, t: string) => {
    if (t && t !== "") await renameConversation(id, t);
    setRenamingId(null);
  };

  const menuAct = async (act: string) => {
    if (!menu) return;
    const id = menu.id;
    setMenu(null);
    if (act === "rename") { setRenamingId(id); return; }
    if (act === "fork") {
      const result = await forkConversation(id);
      if (result) {
        refresh();
        loadConversation(result.conversationId);
      }
      return;
    }
    if (act === "delete") {
      const chat = conversations.find((c) => c.id === id);
      if (!confirm(`Delete "${chat?.title ?? "this chat"}"? This can't be undone.`)) return;
      await deleteConversation(id);
      if (id === activeChatId) router.push("/");
    }
  };

  const handleSignOut = () => {
    if (!confirm("Sign out of Orplex Code?")) return;
    const clearLocal = fetch("/api/session/clear", { method: "POST", credentials: "same-origin" }).catch(() => {});
    const clearNextAuth = signOut({ redirect: false }).catch(() => {});
    void Promise.all([clearLocal, clearNextAuth]).then(() => {
      window.location.assign(new URL("/auth/signin", window.location.origin).toString());
    });
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setDrag(true);
    const move = (ev: MouseEvent) => {
      const w = Math.max(220, Math.min(420, ev.clientX));
      setWidth(w);
      document.documentElement.style.setProperty("--sb-w", `${w}px`);
    };
    const up = () => {
      setDrag(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setWidth((w) => { try { localStorage.setItem("orplex.sidebarWidth", String(w)); } catch {} return w; });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const ql = q.trim().toLowerCase();
  const match = (c: ChatLike) => !ql || c.title.toLowerCase().includes(ql);
  const menuChat = menu ? conversations.find((c) => c.id === menu.id) : undefined;

  const renderChat = (c: ChatLike) => (
    <ChatRow key={c.id} chat={c} q={ql} active={c.id === activeChatId}
      menuOpen={menu?.id === c.id}
      renaming={renamingId === c.id} onSelect={loadConversation}
      onMenu={(id, x, y) => { setTip(null); setMenu({ id, x, y }); }}
      onRename={rename} onHover={onHover} />
  );

  const ungrouped = conversations.filter((c) => !c.workspaceName && match(c));
  const userName = session?.user?.name;
  const userEmail = session?.user?.email;
  const userInitial = (userName ?? userEmail ?? "U").charAt(0).toUpperCase();

  const navContent = (
    <>
      <div className={styles.head}>
        <div className={styles.logo}>
          {/* eslint-disable-next-line @next/next/no-img-element -- local static SVG, crisp edges */}
          <img src="/orplex-mascot.svg" alt="Orplex Code" width={26} height={26} />
          <b className={styles.wm}><W t="Orplex" /><W t="Code" c="c" /></b>
        </div>
        <button className={styles.ibtn} title="Search" aria-label="Search conversations"
          onClick={() => { setSearchOn((s) => !s); setQ(""); setTimeout(() => searchRef.current?.focus(), 30); }}>
          <Icon n="search" />
        </button>
        <button className={styles.ibtn} title="Collapse (Ctrl+\)" aria-label="Collapse sidebar"
          onClick={() => window.dispatchEvent(new CustomEvent("orplex:toggle-sidebar"))}>
          <Icon n="panel" />
        </button>
      </div>

      {searchOn && (
        <div className={styles.search}>
          <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search conversations…" aria-label="Search conversations" />
        </div>
      )}

      <div className={styles.scroll} onScroll={() => setTip(null)}>
        {!ql && <>
          <NavRow icon="newchat" label="New Chat" active={pathname === "/"} onClick={newChat} />
          <NavRow icon="newproj" label="New project" onClick={() => { void openFolder(); setMobileOpen(false); }} />
          <NavRow icon="plug" label="Plugins" active={pathname === "/plugins"} onClick={() => { router.push("/plugins"); setMobileOpen(false); }} />
          <NavRow icon="mem" label="Memory" active={pathname === "/memory"} onClick={() => { router.push("/memory"); setMobileOpen(false); }} />
          <div className={styles.label}>Agents</div>
          <NavRow icon="flow" label="Agent Manager" active={pathname.startsWith("/manager")}
            onClick={() => { router.push("/manager"); setMobileOpen(false); }}
            badge={pendingApprovals > 0 ? <span className={styles.badge}>{pendingApprovals > 9 ? "9+" : pendingApprovals}</span> : undefined} />
          <NavRow icon="board" label="Runs Board" active={pathname.startsWith("/runs")}
            onClick={() => { router.push("/runs"); setMobileOpen(false); }}
            badge={activeRuns >= 2 ? <span className={styles.badge}>{activeRuns > 9 ? "9+" : activeRuns}</span> : undefined} />
        </>}

        {isRunning && task ? (
          <button className={styles.taskRow} onClick={() => { router.push("/"); setMobileOpen(false); }}>
            <span aria-hidden="true">●</span><span className={styles.lbl}>{task.statusDetail}</span>
          </button>
        ) : null}

        <button className={styles.label} onClick={() => setProjectsOpen((o) => !o)} aria-expanded={projectsOpen}>
          Projects
          <Icon n="chev" className={styles.chev} />
        </button>
        <div className={`${styles.kids} ${projectsOpen ? styles.open : ""}`}><div>
          {projects.map((p) => {
            const all = conversations.filter((c) => c.workspaceName === p.name);
            const live = all.filter(match);
            if (ql && !live.length) return null;
            const open = openProjects.has(p.name) || !!ql;
            return (
              <div key={p.name}>
                <button className={`${styles.row} ${open ? styles.active : ""}`} onClick={() => toggleProject(p.name)} aria-expanded={open}>
                  <Icon n={open ? "folderopen" : "folder"} /><span className={styles.lbl}>{projectLabel(p.name, p.displayName)}</span>
                  {/* Hover new-chat in THIS project (user request): attaches the
                      workspace folder, then starts a fresh thread in it. */}
                  <span
                    className={styles.newChat}
                    role="button"
                    tabIndex={0}
                    title={`New chat in ${projectLabel(p.name, p.displayName)}`}
                    aria-label={`New chat in ${projectLabel(p.name, p.displayName)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void (async () => {
                        // New chat IN THIS project: attach its folder silently
                        // (no re-choosing), then start a fresh thread so the
                        // first message lands in this project on save.
                        if (directoryName !== p.name) {
                          let attached = false;
                          const outcome = await reopenProject(p.name);
                          if (outcome.status === "ok") attached = true;
                          if (!attached) {
                            // Handle-less projects (opened from a different
                            // device flow) keep their path in the roster.
                            try {
                              const { listProjects } = await import("@/lib/project-registry");
                              const entry = listProjects(window.localStorage).find((x) => x.name === p.name);
                              if (entry?.lastPath) {
                                await attachPath(entry.lastPath);
                                attached = true;
                              }
                            } catch {}
                          }
                          if (!attached) {
                            // Never block on a picker (user requirement): the
                            // chat still opens, just in the current workspace.
                            toast(
                              `"${p.name}" isn't saved on this device yet — new chat opens in the current workspace.`,
                              "info"
                            );
                          }
                        }
                        window.dispatchEvent(new CustomEvent("orplex:new-chat"));
                        setMobileOpen(false);
                      })();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        const el = e.currentTarget as HTMLElement;
                        el.click();
                      }
                    }}
                  >
                    <Icon n="newchat" />
                  </span>
                </button>
                <div className={`${styles.kids} ${open ? styles.open : ""}`}><div className={styles.chats}>
                  {!live.length && <div className={styles.empty}>No chats yet</div>}
                  {live.map(renderChat)}
                </div></div>
              </div>
            );
          })}
        </div></div>

        {ungrouped.length > 0 && <>
          <button className={styles.label} onClick={() => setChatsOpen((o) => !o)} aria-expanded={chatsOpen}>
            Chats
            <Icon n="chev" className={styles.chev} />
          </button>
          <div className={`${styles.kids} ${chatsOpen ? styles.open : ""}`}><div className={styles.chats}>{ungrouped.map(renderChat)}</div></div>
        </>}
        {ql && !ungrouped.length && !projects.some((p) => conversations.some((c) => c.workspaceName === p.name && match(c))) &&
          <div className={styles.empty} style={{ paddingLeft: 10 }}>No matches</div>}
      </div>

      <div className={styles.foot}>
        {quota ? (
          <div className={styles.usage}>
            <div className={styles.t}><span>Daily requests</span><span>{quota.used}/{quota.limit}</span></div>
            <div className={styles.bar} role="meter" aria-valuenow={Math.round(quota.limit > 0 ? (quota.used / quota.limit) * 100 : 0)} aria-valuemin={0} aria-valuemax={100} aria-label="Daily request usage">
              <i style={{ width: `${Math.min(100, quota.limit > 0 ? (quota.used / quota.limit) * 100 : 0)}%` }} />
            </div>
          </div>
        ) : null}
        <NavRow icon="gear" label="Settings" active={pathname.startsWith("/settings")}
          onClick={() => { router.push("/settings"); setMobileOpen(false); }} />
        <div className={styles.user}>
          <div className={styles.av}>
            {session?.user?.image ? (
              // eslint-disable-next-line @next/next/no-img-element -- arbitrary OAuth avatar host
              <img src={session.user.image} alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
            ) : (
              userInitial
            )}
          </div>
          <div className={styles.n}>
            {status === "loading" ? (
              <b>&nbsp;</b>
            ) : status === "authenticated" ? (
              <><b>{userName ?? "User"}</b><small>{userEmail ?? ""}</small></>
            ) : (
              <><b>Not signed in</b><small>Sign in to sync</small></>
            )}
          </div>
          <button className={styles.ibtn} title={dark ? "Switch to light" : "Switch to dark"} aria-label="Toggle theme" onClick={toggleTheme}><Icon n="sun" /></button>
          {status === "authenticated" ? (
            <button className={styles.ibtn} title="Log out" aria-label="Log out" onClick={handleSignOut}><Icon n="out" /></button>
          ) : null}
        </div>
      </div>

      <div className={styles.grip} onMouseDown={startResize} aria-hidden="true" />

      {tip && !menu && (
        <div className={styles.tip} style={{ left: tip.rect.right + 14, top: tip.rect.top - 6 }}>
          <div className={styles.a}><Icon n="chat" /><span>{tip.chat.title}</span></div>
          <div className={styles.b}><Icon n="clock" />
            <span>{isLocalConversationMode() ? "Stored on this device" : "Stored in the cloud"}</span>
          </div>
        </div>
      )}
      {menu && menuChat ? <ChatMenu pos={menu} chat={menuChat} onAct={menuAct} onClose={() => setMenu(null)} /> : null}
    </>
  );

  const rail = (
    <div className={`${styles.sb} app-sidebar ${drag ? styles.drag : ""}`} style={{ width }}>
      <div className={styles.sbInner} style={{ width }}>{navContent}</div>
    </div>
  );

  return (
    <>
      <div className={styles.sbDesktop} style={{ display: "contents" }}>{rail}</div>
      <button className={styles.hamburger} aria-label="Open menu" onClick={() => setMobileOpen(true)}>
        <Icon n="panel" />
      </button>
      {mobileOpen && (
        <div className={styles.overlay}>
          <div className={styles.backdrop} onClick={() => setMobileOpen(false)} />
          {rail}
        </div>
      )}
    </>
  );
}
