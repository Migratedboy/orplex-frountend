"use client";

/**
 * Strip.tsx — the 44px top strip (spec §2.2): lead (history arrows, bell,
 * Code/Chat toggle), conversation tabs of the active project (+), right-panel
 * tabs in the rzone (+ opens the closed-tab list), and Electron window
 * controls. The whole strip is a window drag region; interactive children are
 * no-drag. Double-clicking empty strip space toggles maximize.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useConversations } from "@/components/ConversationProvider";
import { useFileSystemContext } from "@/components/FileSystemProvider";
import { forkConversation, isLocalConversationMode } from "@/lib/conversations-transport";
import { announceConversationOpen } from "@/lib/navigation-events";
import { Icon, type IconName } from "@/components/ui/Icon";
import { useShell } from "./ShellContext";
import { useRightPanel } from "./RightPanelContext";
import { BellButton, NotifToasts } from "./NotificationsPopover";
import { useNotificationCenter } from "./useNotificationCenter";
import { WindowControls } from "./WindowControls";
import {
  NEW_TAB_ID,
  loadOpenTabs,
  saveOpenTabs,
  withTabOpen,
  withTabClosed,
} from "@/lib/conversation-tabs";
import { TAB_META, closedTabs, type TabId } from "@/lib/panel-state";
import { useToast } from "@/components/Toast";

/* ---------- history arrows ---------- */
function HistoryArrows() {
  const router = useRouter();
  const pathname = usePathname();
  // Tracker: our own navigation increments depth; Back/Forward move the
  // index. Disabled states follow the index honestly.
  const depth = useRef(0);
  const index = useRef(0);
  const [canBack, setCanBack] = useState(false);
  const [canFwd, setCanFwd] = useState(false);
  const moving = useRef<null | "back" | "fwd">(null);

  useEffect(() => {
    if (moving.current === "back") {
      index.current = Math.max(0, index.current - 1);
    } else if (moving.current === "fwd") {
      index.current = Math.min(depth.current, index.current + 1);
    } else {
      // A push (new entry) truncates any forward history.
      depth.current = index.current + 1;
      index.current = depth.current;
    }
    moving.current = null;
    setCanBack(index.current > 1);
    setCanFwd(index.current < depth.current);
  }, [pathname]);

  const go = (dir: "back" | "fwd") => {
    moving.current = dir;
    router[dir === "back" ? "back" : "forward"]();
  };

  return (
    <div className="ox-nav">
      <button aria-label="Back" disabled={!canBack} onClick={() => go("back")}><Icon name="back" size={15} /></button>
      <button aria-label="Forward" disabled={!canFwd} onClick={() => go("fwd")}><Icon name="fwd" size={15} /></button>
    </div>
  );
}

/* ---------- Code / Chat segmented toggle (Decision D2) ---------- */
function SurfaceToggle() {
  const { surfaceMode, setSurfaceMode } = useShell();
  return (
    <div className="ox-seg" role="group" aria-label="Surface mode">
      <button className={surfaceMode === "code" ? "on" : ""} aria-pressed={surfaceMode === "code"} onClick={() => setSurfaceMode("code")}>Code</button>
      <button className={surfaceMode === "chat" ? "on" : ""} aria-pressed={surfaceMode === "chat"} onClick={() => setSurfaceMode("chat")}>Chat</button>
    </div>
  );
}

/* ---------- conversation tabs ---------- */
interface ConvTabMenu { id: string; x: number; y: number }

function ConversationTabs() {
  const router = useRouter();
  const pathname = usePathname();
  const { conversations } = useConversations();
  const { directoryName } = useFileSystemContext();
  const { toast } = useToast();
  const { setMobileSideOpen } = useShell();
  const [tabs, setTabs] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [menu, setMenu] = useState<ConvTabMenu | null>(null);
  const projRef = useRef<string>("");

  // Active chat follows the ?c= query (same contract as Sidebar).
  useEffect(() => {
    const read = () => setActiveId(new URLSearchParams(window.location.search).get("c"));
    read();
    window.addEventListener("popstate", read);
    window.addEventListener("orplex:open-conversation", read);
    const interval = setInterval(() => {
      const current = new URLSearchParams(window.location.search).get("c");
      setActiveId((prev) => (prev === current ? prev : current));
    }, 400);
    return () => {
      window.removeEventListener("popstate", read);
      window.removeEventListener("orplex:open-conversation", read);
      clearInterval(interval);
    };
  }, []);

  // Which project's strip is this? The open conversation's workspace, else
  // the attached folder, else ungrouped.
  const projectId = useMemo(() => {
    const conv = activeId ? conversations.find((c) => c.id === activeId) : undefined;
    return conv?.workspaceName || directoryName || "default";
  }, [activeId, conversations, directoryName]);

  // Load this project's open-tab list on project change.
  useEffect(() => {
    if (projRef.current === projectId) return;
    projRef.current = projectId;
    setTabs(loadOpenTabs(projectId));
  }, [projectId]);

  // Keep active/unsaved-new tabs present; persist.
  useEffect(() => {
    setTabs((prev) => {
      let next = prev;
      if (activeId) next = withTabOpen(next, activeId);
      // An unsaved "New chat" tab only lives while the user is actually on a
      // fresh chat; it yields once a real conversation is active.
      if (activeId && next.includes(NEW_TAB_ID)) next = next.filter((t) => t !== NEW_TAB_ID);
      if (next !== prev) {
        saveOpenTabs(projectId, next);
        return next;
      }
      return prev;
    });
  }, [activeId, projectId]);

  const persist = useCallback((next: string[]) => {
    setTabs(next);
    saveOpenTabs(projectId, next);
  }, [projectId]);

  const titleFor = useCallback((id: string): string => {
    if (id === NEW_TAB_ID) return "New chat";
    return conversations.find((c) => c.id === id)?.title ?? "Chat";
  }, [conversations]);

  const openTab = useCallback((id: string) => {
    if (id === NEW_TAB_ID) {
      router.push("/");
      return;
    }
    router.push(`/?c=${encodeURIComponent(id)}`);
    announceConversationOpen(id);
  }, [router]);

  const closeTab = useCallback((id: string) => {
    const { list, nextActive } = withTabClosed(tabs, activeId, id);
    persist(list);
    if (nextActive === activeId) return;
    if (nextActive && nextActive !== NEW_TAB_ID) {
      router.push(`/?c=${encodeURIComponent(nextActive)}`);
      announceConversationOpen(nextActive);
    } else if (nextActive === NEW_TAB_ID) {
      router.push("/");
    } else {
      router.push("/");
    }
  }, [tabs, activeId, persist, router]);

  const newChat = useCallback(() => {
    persist(withTabOpen(tabs, NEW_TAB_ID));
    router.push("/");
    setMobileSideOpen(false);
  }, [tabs, persist, router, setMobileSideOpen]);

  const forkFromMenu = useCallback(async (id: string) => {
    setMenu(null);
    try {
      const result = await forkConversation(id);
      if (!result) {
        toast("Fork failed — the thread may have been deleted.", "error");
        return;
      }
      toast(`Forked — ${result.copied} message${result.copied === 1 ? "" : "s"} copied.`, "success");
      router.push(`/?c=${result.conversationId}`);
      announceConversationOpen(result.conversationId);
    } catch {
      toast("Fork failed — please try again.", "error");
    }
  }, [router, toast]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("orplex:close-popovers", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("orplex:close-popovers", close);
    };
  }, [menu]);

  const canFork = isLocalConversationMode();
  const menuConv = menu ? conversations.find((c) => c.id === menu.id) : undefined;

  return (
    <>
      <div className="ox-tabs" role="tablist" aria-label="Conversation tabs">
        {tabs.map((id) => {
          const active = id === activeId || (id === NEW_TAB_ID && !activeId && pathname === "/");
          const title = titleFor(id);
          return (
            <div
              key={id}
              className={`ox-tab ${active ? "on" : ""}`}
              role="tab"
              aria-selected={active}
              title={title}
              onClick={(e) => { if (!(e.target as HTMLElement).closest(".ox-tx")) openTab(id); }}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ id, x: e.clientX, y: e.clientY }); }}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(id); } }}
            >
              <Icon name="branch" size={14} />
              <span>{title}</span>
              <button
                className="ox-tx"
                aria-label={`Close ${title}`}
                title={`Close ${title}`}
                onClick={(e) => { e.stopPropagation(); closeTab(id); }}
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          );
        })}
        <button className="ox-add" aria-label="New conversation" title="New chat" onClick={newChat}>
          <Icon name="plus" size={15} />
        </button>
      </div>
      {menu && (
        <div className="ox-tabmenu" style={{ left: Math.min(menu.x, window.innerWidth - 190), top: menu.y + 4 }} role="menu">
          <button role="menuitem" onClick={() => openTab(menu.id)}>
            <Icon name="chev" size={13} /> Switch to tab
          </button>
          <button role="menuitem" disabled={!canFork || !menuConv}
            title={canFork ? undefined : "Fork is available in the desktop app"}
            onClick={() => void forkFromMenu(menu.id)}>
            <Icon name="branch" size={13} /> Fork chat
          </button>
          <button role="menuitem" onClick={() => { setMenu(null); closeTab(menu.id); }}>
            <Icon name="x" size={13} /> Close tab
          </button>
        </div>
      )}
    </>
  );
}

/* ---------- right-panel tabs in the rzone ---------- */
const TAB_ICONS: Record<TabId, IconName> = {
  queue: "tasks",
  changes: "branch",
  browser: "laptop",
  terminal: "term",
  files: "folder",
  scratch: "edit" as IconName,
};

function RightPanelTabs() {
  const rp = useRightPanel();
  const { setOverlayOpen } = rp;
  const [popOpen, setPopOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  // Popovers over the browser view freeze its native snapshot (same contract
  // the old in-panel TabBar used via onPopoverChange).
  useEffect(() => {
    setOverlayOpen(popOpen);
    return () => setOverlayOpen(false);
  }, [popOpen, setOverlayOpen]);

  useEffect(() => {
    if (!popOpen) return;
    const onDown = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      const pop = document.querySelector(".ox-rpop");
      if (pop?.contains(e.target as Node)) return;
      setPopOpen(false);
    };
    const close = () => setPopOpen(false);
    document.addEventListener("mousedown", onDown, { passive: true });
    window.addEventListener("orplex:close-popovers", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("orplex:close-popovers", close);
    };
  }, [popOpen]);

  const closed = closedTabs(rp.tabs);

  return (
    <div className="ox-tabs" role="tablist" aria-label="Right panel tabs">
      {rp.tabs.map((id) => {
        const active = id === rp.activeTab;
        const meta = TAB_META[id];
        return (
          <div
            key={id}
            className={`ox-tab ${active ? "on" : ""}`}
            role="tab"
            aria-selected={active}
            title={meta.label}
            onClick={() => rp.activate(id)}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); rp.close(id); } }}
          >
            <Icon name={TAB_ICONS[id] ?? "tasks"} size={14} />
            <span>{meta.label}</span>
            <button className="ox-tx" aria-label={`Close ${meta.label} tab`} onClick={(e) => { e.stopPropagation(); rp.close(id); }}>
              <Icon name="x" size={11} />
            </button>
          </div>
        );
      })}
      <button
        ref={btnRef}
        className="ox-add"
        aria-label="New panel tab"
        aria-haspopup="menu"
        aria-expanded={popOpen}
        title="Open a tab"
        onClick={() => setPopOpen((v) => !v)}
      >
        <Icon name="plus" size={15} />
      </button>
      {popOpen && (
        <div
          className="ox-rpop"
          style={{ left: Math.max(8, (btnRef.current?.getBoundingClientRect().left ?? 0) - 130), top: (btnRef.current?.getBoundingClientRect().bottom ?? 44) + 6 }}
          role="menu"
        >
          {closed.length === 0 ? (
            <div className="ox-rpop-none">All tabs are open</div>
          ) : (
            closed.map((id) => (
              <button key={id} role="menuitem" onClick={() => { rp.open(id); setPopOpen(false); }}>
                <Icon name={TAB_ICONS[id] ?? "tasks"} size={14} />
                {TAB_META[id].label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- the strip ---------- */
export default function Strip() {
  const { sidebarCollapsed } = useShell();
  // ONE notification poller for the whole shell: bell + toast stack consume it.
  const notif = useNotificationCenter();

  return (
    <>
      <header className="ox-strip" data-tour-id="strip">
        <div className="ox-lead">
          <HistoryArrows />
          {!sidebarCollapsed && (
            <div className="ox-lead-r">
              <BellButton notif={notif} />
              <SurfaceToggle />
            </div>
          )}
        </div>
        <ConversationTabs />
        <div className="ox-rzone">
          <RightPanelTabs />
          <WindowControls />
        </div>
      </header>
      <NotifToasts notif={notif} />
    </>
  );
}
