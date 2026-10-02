"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { useState, useCallback, useEffect } from "react";
import { useConversations } from "./ConversationProvider";
import { IconEdit, IconTrash, IconClose, IconMenu } from "./Icons";
import { useFileSystemContext } from "./FileSystemProvider";
import { useBackgroundChat } from "@/hooks/useBackgroundChat";
import { announceConversationOpen } from "@/lib/navigation-events";
import { useActiveRunCount } from "@/hooks/useActiveRunCount";
import { nextConfirmState, type ConfirmState, type ProjectMenuItemId } from "@/lib/project-menu";
import { threadsForProject, ungroupedThreads, type ThreadLike } from "@/lib/project-threads";
import { useWorkspace } from "./WorkspaceProvider";
import { ProjectContextMenu } from "./ProjectSidebarParts";
import ProjectBranchedMenu from "./ProjectBranchedMenu";
import BranchedMenu, { MsIcon } from "./BranchedMenu";
import type { ProjectEntry } from "@/lib/project-registry";

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

  // Which settings tab the nav should highlight. Kept in step with the URL
  // (?tab= deep links) and with tab switches made inside the settings page
  // (orplex:settings-tab event) — usePathname can't see query params.
  const [settingsTab, setSettingsTab] = useState("profile");
  useEffect(() => {
    const readUrlTab = () => {
      const t = new URLSearchParams(window.location.search).get("tab");
      if (t) setSettingsTab(t);
    };
    if (pathname.startsWith("/settings")) readUrlTab();
    const onSettingsTab = (e: Event) => setSettingsTab((e as CustomEvent<string>).detail);
    window.addEventListener("orplex:settings-tab", onSettingsTab);
    window.addEventListener("popstate", readUrlTab);
    return () => {
      window.removeEventListener("orplex:settings-tab", onSettingsTab);
      window.removeEventListener("popstate", readUrlTab);
    };
  }, [pathname]);

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
        <img src="/logo.svg" alt="Orplex Code" className="sidebar-brand-logo" />
        <div className="sidebar-brand-text">
          <h1>Orplex Code</h1>
          <span>Vivid Catalyst</span>
        </div>
      </div>
      <div className="sidebar-nav-items">
        {/* Branched menu (BranchedMenu.tsx): New Chat + History as leaves,
            Agent Manager + Runs Board grouped under an "Agents" branch and
            the settings tabs under a "Settings" branch, both with the
            animated trunk. Plugins stays a leaf. Badges (active runs /
            pending approvals) ride on the board rows. */}
        <BranchedMenu
          items={[
            {
              label: "New Chat",
              value: "/",
              children: undefined,
            },
            {
              label: "History",
              value: "/history",
            },
            {
              label: "Agents",
              children: [
                {
                  value: "/manager",
                  label: "Agent Manager",
                  icon: <MsIcon name="hub" />,
                  badge:
                    pendingApprovals > 0 ? (
                      <span className="sidebar-nav-badge sidebar-nav-badge-warn" title={`${pendingApprovals} approval(s) pending`}>
                        {pendingApprovals > 9 ? "9+" : pendingApprovals}
                      </span>
                    ) : undefined,
                },
                {
                  value: "/runs",
                  label: "Runs Board",
                  icon: <MsIcon name="view_kanban" />,
                  badge:
                    activeRuns >= 2 ? (
                      <span className="sidebar-nav-badge" title={`${activeRuns} active runs`}>
                        {activeRuns > 9 ? "9+" : activeRuns}
                      </span>
                    ) : undefined,
                },
              ],
            },
            {
              label: "Plugins",
              value: "/plugins",
            },
            {
              label: "Settings",
              children: [
                { value: "/settings?tab=profile", label: "Profile", icon: <MsIcon name="person" /> },
                { value: "/settings?tab=appearance", label: "Appearance", icon: <MsIcon name="palette" /> },
                { value: "/settings?tab=cost", label: "Provider & Cost", icon: <MsIcon name="payments" /> },
                { value: "/settings?tab=api", label: "API Keys", icon: <MsIcon name="key" /> },
                { value: "/settings?tab=about", label: "About", icon: <MsIcon name="info" /> },
                { value: "/settings?tab=danger", label: "Reset & Recovery", icon: <MsIcon name="restart_alt" /> },
              ],
            },
          ]}
          // defaultActive carries the ?tab= query, matching the child values
          // so the trunk reach + highlight follow deep links ( BranchedMenu
          // syncs this via a useEffect when the pathname changes).
          defaultActive={
            pathname === "/" || pathname === "/history" || pathname === "/plugins"
              ? pathname
              : pathname.startsWith("/manager")
                ? "/manager"
                : pathname.startsWith("/runs")
                  ? "/runs"
                  : pathname.startsWith("/settings")
                    ? `/settings?tab=${settingsTab}`
                    : ""
          }
          // Open: the Agents branch (index 2), plus Settings (index 4) while
          // the user is anywhere in /settings so the tree shows where they are.
          defaultOpen={pathname.startsWith("/settings") ? [2, 4] : [2]}
          onSelect={(value) => {
            if (value === "/") {
              window.dispatchEvent(new CustomEvent("orplex:new-chat"));
            }
            if (value.startsWith("/settings?tab=")) {
              // The page may already be mounted — a query-only push doesn't
              // re-run its mount effect, so tell it which tab directly.
              window.dispatchEvent(
                new CustomEvent("orplex:settings-tab", { detail: value.slice("/settings?tab=".length) })
              );
            }
            router.push(value);
            setMobileOpen(false);
          }}
        />

        <BackgroundTaskIndicator />

        {projects.length > 0 && (
          <div className="conv-section">
            <div className="conv-section-label">Projects</div>
            {projects.map((project) => (
              <ProjectBranchedMenu
                key={project.name}
                project={project}
                conversations={conversations}
                activeProject={directoryName}
                expanded={expandedProjects.has(project.name)}
                onToggle={toggleProject}
                onReopen={handleReopenProject}
                onOpenThread={loadConversation}
                onContextMenu={(proj, anchor) => {
                  setMenuConfirm("idle"); // re-right-click cancels an armed confirm
                  setMenuAnchor(anchor);
                  setMenuProject(proj);
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
              <ProjectBranchedMenu
                project={{ name: "", lastOpenedAt: 0 }}
                conversations={conversations}
                activeProject={directoryName}
                expanded={expandedProjects.has("__ungrouped__")}
                onToggle={toggleProject}
                onReopen={() => toggleProject("__ungrouped__")}
                onOpenThread={loadConversation}
                onContextMenu={() => {}} // Ungrouped skips the menu
                sectionLabel="Ungrouped"
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
