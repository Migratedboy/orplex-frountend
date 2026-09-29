"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { useState, useCallback, useEffect } from "react";
import { useConversations } from "./ConversationProvider";
import { IconChat, IconHistory, IconPlugins, IconSettings, IconEdit, IconTrash, IconClose, IconMenu, IconAgent } from "./Icons";
import { useFileSystemContext } from "./FileSystemProvider";
import { useBackgroundChat } from "@/hooks/useBackgroundChat";
import { announceConversationOpen } from "@/lib/navigation-events";
import { useActiveRunCount } from "@/hooks/useActiveRunCount";
import { nextConfirmState, type ConfirmState, type ProjectMenuItemId } from "@/lib/project-menu";
import { threadsForProject, ungroupedThreads, type ThreadLike } from "@/lib/project-threads";
import { useWorkspace } from "./WorkspaceProvider";
import { ProjectContextMenu, ProjectRow } from "./ProjectSidebarParts";
import type { ProjectEntry } from "@/lib/project-registry";

const NAV_ITEMS = [
  { href: "/history", label: "History", Icon: IconHistory },
  { href: "/manager", label: "Agent Manager", Icon: IconAgent, badge: "runs" as const },
  { href: "/runs", label: "Runs Board", Icon: IconAgent, badge: "runs" as const },
  { href: "/plugins", label: "Plugins", Icon: IconPlugins },
  { href: "/settings", label: "Settings", Icon: IconSettings },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  const { conversations, renameConversation, deleteConversation: removeConversation } = useConversations();
  const { directoryName, reopenProject } = useFileSystemContext();
  const { activeRuns, pendingApprovals } = useActiveRunCount();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  // === Projects section ===
  // useProjects (via WorkspaceProvider) owns the roster + sync; the sidebar
  // only tracks which rows are expanded and which project's menu/confirm is open.
  const { projects, forget: forgetProjectEverywhere, alias: setAlias, touch } = useWorkspace();
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [reopening, setReopening] = useState<string | null>(null);
  // Context menu state: which project, where, and the destructive-confirm FSM.
  const [menuProject, setMenuProject] = useState<ProjectEntry | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [menuConfirm, setMenuConfirm] = useState<ConfirmState>("idle");

  const toggleProject = useCallback((name: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const handleReopenProject = useCallback(
    async (name: string) => {
      if (reopening) return; // one permission prompt at a time
      setReopening(name);
      try {
        const outcome = await reopenProject(name);
        if (outcome.status === "ok") {
          setExpandedProjects((prev) => new Set(prev).add(name));
          touch(name); // roster re-read + sync (active/ghost flags may have changed)
        }
      } finally {
        setReopening(null);
      }
    },
    [reopenProject, reopening, touch]
  );

  // === Context menu actions — mutators live on useProjects ===
  const handleMenuAction = useCallback(
    async (id: ProjectMenuItemId, project: ProjectEntry) => {
      const name = project.name;
      if (id === "remove-and-delete") {
        // Two-step confirm: first click arms (the item re-renders as
        // "Really delete threads?"), second click executes. Anything else
        // (dismiss, other item, re-right-click) cancels via nextConfirmState.
        const next = nextConfirmState(menuConfirm, "remove-and-delete");
        if (next !== "executed") {
          setMenuConfirm(next);
          return;
        }
        // Delete the project's tagged threads, then forget the project
        // (locally AND server-side, so sync can't resurrect it as a ghost).
        const tagged = conversations.filter((c) => c.workspaceName === name);
        for (const c of tagged) {
          await removeConversation(c.id).catch(() => {});
        }
        forgetProjectEverywhere(name);
        setMenuConfirm("idle");
        setMenuProject(null);
        setExpandedProjects((prev) => {
          const n = new Set(prev);
          n.delete(name);
          return n;
        });
        return;
      }
      // Any non-destructive action cancels an armed confirm.
      setMenuConfirm("idle");
      if (id === "remove") {
        // Forgets locally (roster + handle) + remote tombstone. Files/threads
        // untouched — threads keep their workspaceName tag and reappear if
        // the folder is opened again.
        forgetProjectEverywhere(name);
        setMenuProject(null);
      } else if (id === "rename") {
        // The inline editor commits through here with the new alias on the
        // project object (onCommit builds it); no prompt() dialog.
        setAlias(name, project.displayName ?? null);
      } else if (id === "reveal") {
        if (project.lastPath) {
          window.orplexDesktop?.revealPath?.(project.lastPath).catch(() => {});
        }
        setMenuProject(null);
      }
    },
    [menuConfirm, conversations, removeConversation, forgetProjectEverywhere, setAlias]
  );

  const loadConversation = (id: string) => {
    router.push(`/?c=${id}`);
    // SPA push doesn't remount '/' — tell the mounted hook to load it.
    announceConversationOpen(id);
    setMobileOpen(false);
  };

  const handleRename = async (id: string) => {
    if (!editTitle.trim()) return;
    await renameConversation(id, editTitle.trim());
    setEditingId(null);
  };

  const handleDelete = async (id: string) => {
    await removeConversation(id);
  };

  const navContent = (
    <>
      <div className="sidebar-brand">
        <img src="/logo.png" alt="Orplex Tech" className="sidebar-brand-logo" />
        <div className="sidebar-brand-text">
          <h1>Orplex Tech</h1>
          <span>Vivid Catalyst</span>
        </div>
      </div>
      <div className="sidebar-nav-items">
        <button
          onClick={() => {
            // Clear chat state via event (picked up by useChatSession if mounted)
            window.dispatchEvent(new CustomEvent("orplex:new-chat"));
            // Also navigate directly — works even when ChatPage isn't mounted (e.g. on /history)
            router.push("/");
            setMobileOpen(false);
          }}
          className={`sidebar-nav-item ${pathname === "/" ? "active" : ""}`}
        >
          <IconChat size={16} /> <span>New Chat</span>
        </button>
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            prefetch={true}
            onClick={() => setMobileOpen(false)}
            onMouseEnter={() => router.prefetch(item.href)}
            className={`sidebar-nav-item ${pathname === item.href ? "active" : ""}`}
          >
            <item.Icon size={16} /> <span>{item.label}</span>
            {item.badge === "runs" && activeRuns >= 2 && (
              <span className="sidebar-nav-badge" title={`${activeRuns} active runs`}>
                {activeRuns > 9 ? "9+" : activeRuns}
              </span>
            )}
            {item.badge === "runs" && pendingApprovals > 0 && (
              <span className="sidebar-nav-badge sidebar-nav-badge-warn" title={`${pendingApprovals} approval(s) pending`}>
                {pendingApprovals > 9 ? "9+" : pendingApprovals}
              </span>
            )}
          </Link>
        ))}

        <BackgroundTaskIndicator />

        {projects.length > 0 && (
          <div className="conv-section">
            <div className="conv-section-label">Projects</div>
            {projects.map((project) => (
              <ProjectRow
                key={project.name}
                project={project}
                active={directoryName === project.name}
                expanded={expandedProjects.has(project.name)}
                onToggle={() => toggleProject(project.name)}
                onReopen={() => handleReopenProject(project.name)}
                onOpenThread={loadConversation}
                threads={threadsForProject(conversations, project.name)}
                onContextMenu={(anchor) => {
                  setMenuConfirm("idle"); // re-right-click cancels an armed confirm
                  setMenuAnchor(anchor);
                  setMenuProject(project);
                }}
              />
            ))}
          </div>
        )}

        {(() => {
          const orphans = ungroupedThreads(conversations);
          if (orphans.length === 0) return null;
          return (
            <div className="conv-section">
              <div className="conv-section-label">Chats</div>
              <ProjectRow
                project={{ name: "", lastOpenedAt: 0 }}
                active={false}
                expanded={expandedProjects.has("__ungrouped__")}
                onToggle={() => toggleProject("__ungrouped__")}
                onReopen={() => toggleProject("__ungrouped__")}
                onOpenThread={loadConversation}
                threads={orphans}
                onContextMenu={() => {}} // unused — Ungrouped skips the menu
              />
            </div>
          );
        })()}
      </div>
      <div className="sidebar-user">
        <div className="sidebar-user-info">
          {session?.user?.image ? (
            <div className="sidebar-user-avatar">
              <img src={session.user.image} alt="User" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).nextElementSibling?.classList.remove("avatar-fallback-hidden"); }} />
              <span className="avatar-fallback avatar-fallback-hidden">{(session?.user?.name || "U")[0].toUpperCase()}</span>
            </div>
          ) : (
            <div className="sidebar-user-avatar"><span>{(session?.user?.name || "U")[0].toUpperCase()}</span></div>
          )}
          <div>
            <div className="sidebar-user-name">{session?.user?.name || "User"}</div>
            <div className="sidebar-user-email">{session?.user?.email || ""}</div>
          </div>
        </div>
        <button className="sidebar-signout" onClick={() => signOut({ callbackUrl: "/auth/signin" })}>Sign Out</button>
      </div>
    </>
  );

  return (
    <>
      {menuProject && (
        <ProjectContextMenu
          project={menuProject}
          anchor={menuAnchor}
          isActive={directoryName === menuProject.name}
          confirmState={menuConfirm}
          onAction={handleMenuAction}
          onDismiss={() => {
            setMenuConfirm("idle");
            setMenuProject(null);
          }}
        />
      )}
      <button onClick={() => setMobileOpen(true)} className="mobile-hamburger" aria-label="Open menu">
        <IconMenu size={20} />
      </button>
      <nav className="sidebar-nav">{navContent}</nav>
      {mobileOpen && (
        <div className="mobile-overlay">
          <div className="mobile-backdrop" onClick={() => setMobileOpen(false)} />
          <nav className="sidebar-nav sidebar-nav-mobile">
            <button onClick={() => setMobileOpen(false)} className="mobile-close-btn" aria-label="Close menu"><IconClose size={20} /></button>
            {navContent}
          </nav>
        </div>
      )}
    </>
  );
}


function BackgroundTaskIndicator() {
  const { task, isRunning } = useBackgroundChat();
  const router = useRouter();

  if (!isRunning || !task) return null;

  return (
    <div
      onClick={() => router.push("/")}
      className="mt-3 mx-2 px-3 py-2 rounded-lg border border-[#E4E4E7] bg-[#FAFAFA] cursor-pointer hover:bg-[#F4F4F5] transition-colors"
    >
      <div className="flex items-center gap-2">
        <div className="bg-task-dot" />
        <span className="text-[11px] font-medium text-[#52525B] truncate">
          {task.statusDetail}
        </span>
      </div>
      <div className="text-[10px] text-[#A1A1AA] mt-1 truncate">
        {task.userMessage.slice(0, 50)}{task.userMessage.length > 50 ? "…" : ""}
      </div>
    </div>
  );
}
