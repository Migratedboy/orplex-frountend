"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { useState, useEffect, useCallback } from "react";
import { useConversations } from "./ConversationProvider";
import { IconChat, IconHistory, IconPlugins, IconSettings, IconEdit, IconTrash, IconClose, IconMenu, IconAgent } from "./Icons";
import { useFileSystemContext, FileNode } from "./FileSystemProvider";
import { useBackgroundChat } from "@/hooks/useBackgroundChat";
import { useActiveRunCount } from "@/hooks/useActiveRunCount";
import { virtualFS, VirtualFileNode } from "@/lib/virtual-fs";

const NAV_ITEMS = [
  { href: "/history", label: "History", Icon: IconHistory },
  { href: "/runs", label: "Runs Board", Icon: IconAgent, badge: "runs" as const },
  { href: "/plugins", label: "Plugins", Icon: IconPlugins },
  { href: "/settings", label: "Settings", Icon: IconSettings },
];

function FileTreeItem({ node, depth = 0 }: { node: FileNode; depth: number }) {
  const { activeFilePath, setActiveFilePath, readFile } = useFileSystemContext();
  const [collapsed, setCollapsed] = useState(true);

  const handleClick = async () => {
    if (node.kind === "directory") {
      setCollapsed(!collapsed);
    } else {
      setActiveFilePath(node.path);
      await readFile(node.path);
    }
  };

  return (
    <div>
      <div
        onClick={handleClick}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        className={`flex items-center gap-2 py-1 px-2 rounded cursor-pointer text-[12px] transition-colors ${
          activeFilePath === node.path
            ? "bg-[#FFF7ED] text-[#a04100] font-bold"
            : "hover:bg-[#f3f3f4] text-[#5f5e5e]"
        }`}
      >
        <span className="sidebar-file-icon">{node.kind === "directory" ? (collapsed ? ">" : "v") : "-"}</span>
        <span className="truncate flex-1">{node.name}</span>
      </div>
      {node.kind === "directory" && !collapsed && node.children && (
        <div className="flex flex-col">
          {node.children.map((child: FileNode) => (
            <FileTreeItem key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// Virtual file tree for AI-created files (when no folder is open)
function VirtualFileItem({ node, depth = 0 }: { node: VirtualFileNode; depth: number }) {
  const [collapsed, setCollapsed] = useState(true);
  const isDir = node.kind === "directory";

  return (
    <div>
      <div
        className={`sidebar-file-item flex items-center gap-1 cursor-pointer hover:bg-gray-100 rounded px-1 py-0.5 text-[11px]`}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onClick={() => isDir ? setCollapsed(!collapsed) : null}
      >
        <span className="sidebar-file-icon text-[10px] text-gray-400" style={{ width: 12 }}>
          {isDir ? (collapsed ? ">" : "v") : "-"}
        </span>
        <span className="truncate flex-1 text-gray-700 font-mono">{node.name}</span>
      </div>
      {isDir && !collapsed && node.children && (
        <div className="flex flex-col">
          {node.children.map((child) => (
            <VirtualFileItem key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function handleExportZip() {
  virtualFS.toZip().then((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "orplex-project.zip";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  const { conversations, renameConversation, deleteConversation } = useConversations();
  const { openFolder, directoryName, fileTree, readFile } = useFileSystemContext();
  const { activeRuns, pendingApprovals } = useActiveRunCount();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [virtualTree, setVirtualTree] = useState<VirtualFileNode[]>([]);
  const [virtualCount, setVirtualCount] = useState(0);

  // Subscribe to virtual FS changes
  useEffect(() => {
    const update = () => {
      setVirtualTree(virtualFS.getTree());
      setVirtualCount(virtualFS.getFileCount());
    };
    update();
    return virtualFS.subscribe(update);
  }, []);

  const handleExportZipClick = useCallback(async () => {
    // If we have a real folder open, export those files
    if (directoryName && fileTree.length > 0) {
      try {
        const JSZip = (await import("jszip")).default;
        const zip = new JSZip();
        const walkAndZip = async (nodes: FileNode[]) => {
          for (const node of nodes) {
            if (node.kind === "file") {
              try {
                const content = await readFile(node.path);
                zip.file(node.path, content);
              } catch {}
            }
            if (node.kind === "directory" && node.children) {
              await walkAndZip(node.children);
            }
          }
        };
        await walkAndZip(fileTree);
        const blob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${directoryName || "orplex-project"}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error("Export failed:", err);
      }
    } else {
      // Export virtual FS files
      handleExportZip();
    }
  }, [directoryName, fileTree, readFile]);

  const loadConversation = (id: string) => { router.push(`/?c=${id}`); setMobileOpen(false); };

  const handleRename = async (id: string) => {
    if (!editTitle.trim()) return;
    await renameConversation(id, editTitle.trim());
    setEditingId(null);
  };

  const handleDelete = async (id: string) => {
    await deleteConversation(id);
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

        <div className="border-t border-[#E4E4E7] my-4 pt-4 shrink-0">
          <div className="conv-section-label flex justify-between items-center mb-2">
            <span>Local Workspace</span>
            <div className="flex gap-1">
              {(virtualCount > 0 || fileTree.length > 0) && (
                <button
                  onClick={handleExportZipClick}
                  className="text-[10px] bg-[#FF6B00] text-white border border-[#E05500] rounded px-2 py-0.5 hover:bg-[#E05500] transition-colors font-semibold"
                  title="Download all files as .zip"
                >
                  Export .zip
                </button>
              )}
              <button
                onClick={openFolder}
                className="text-[10px] bg-[#FFF7ED] text-[#a04100] border border-[#a04100]/20 rounded px-2 py-0.5 hover:bg-[#a04100]/10 transition-colors"
              >
                {directoryName ? "Change" : "Open"}
              </button>
            </div>
          </div>
          {directoryName ? (
            <div className="font-code text-[11px] max-h-[300px] overflow-y-auto border border-[#E4E4E7] rounded p-1 bg-gray-50">
              <div className="flex flex-col gap-0.5">
                {fileTree.map((node) => (
                  <FileTreeItem key={node.path} node={node} depth={0} />
                ))}
              </div>
            </div>
          ) : virtualCount > 0 ? (
            <div className="font-code text-[11px] max-h-[300px] overflow-y-auto border border-[#E4E4E7] rounded p-1 bg-gray-50">
              <div className="text-[10px] text-[#FF6B00] font-semibold px-1 py-0.5 mb-1">
                {virtualCount} file(s) created by AI
              </div>
              <div className="flex flex-col gap-0.5">
                {virtualTree.map((node) => (
                  <VirtualFileItem key={node.path} node={node} depth={0} />
                ))}
              </div>
            </div>
          ) : (
            <div className="text-center py-4 text-[12px] text-on-surface-variant italic">
              No folder opened. AI will create files here.
            </div>
          )}
        </div>

        {conversations.length > 0 && (
          <div className="conv-section">
            <div className="conv-section-label">Recent Chats</div>
            {conversations.slice(0, 5).map((conv) => (
              <div key={conv.id} className="conv-item">
                {editingId === conv.id ? (
                  <input className="form-input conv-edit-input" value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onBlur={() => handleRename(conv.id)}
                    onKeyDown={(e) => e.key === "Enter" && handleRename(conv.id)} autoFocus />
                ) : (
                  <button className="conv-item-title" onClick={() => loadConversation(conv.id)}>{conv.title}</button>
                )}
                <div className="conv-item-actions">
                  <button className="conv-action-btn" onClick={() => { setEditingId(conv.id); setEditTitle(conv.title); }} title="Rename" aria-label="Rename conversation">
                    <IconEdit size={12} />
                  </button>
                  <button className="conv-action-btn" onClick={() => handleDelete(conv.id)} title="Delete" aria-label="Delete conversation">
                    <IconTrash size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
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
