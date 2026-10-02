"use client";

// ProjectBranchedMenu.tsx — the Projects / Chats sections rendered with the
// BranchedMenu tree language: each project is a collapsible branch, its
// threads are children connected by the animated SVG trunk, and the orange
// "reach" line points at the open conversation.
//
// Behavior preserved from ProjectRow:
//   • right-click / mobile long-press on the header → project context menu
//   • click project name → reopen/switch that workspace (ghosts re-locate)
//   • click thread → open the conversation
//   • >4 threads → "Load threads…" link to the filtered History page
//   • ghost projects get the quiet "not on this device" chip

import { useEffect, useState } from "react";
import BranchedMenu, { MsIcon } from "./BranchedMenu";
import type { BranchedChild, BranchedItem } from "./BranchedMenu";
import { projectLabel, type ThreadLike } from "@/lib/project-threads";
import type { ProjectEntry } from "@/lib/project-registry";

interface ProjectBranchedMenuProps {
  project: ProjectEntry;
  conversations: ThreadLike[];
  activeProject: string | null;
  expanded: boolean;
  onToggle: (name: string) => void;
  onReopen: (name: string) => void;
  onOpenThread: (id: string) => void;
  onContextMenu: (project: ProjectEntry, anchor: { x: number; y: number }) => void;
  /** Section header label override ("Chats" for the Ungrouped row). */
  sectionLabel?: string;
}

const CAP = 4;

export default function ProjectBranchedMenu({
  project,
  conversations,
  activeProject,
  expanded,
  onToggle,
  onReopen,
  onOpenThread,
  onContextMenu,
  sectionLabel,
}: ProjectBranchedMenuProps) {
  // The open conversation id, read from the URL (?c=<id>) — same param the
  // sidebar's loadConversation navigates with. Polled lightly; re-renders
  // only when it actually changes.
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  useEffect(() => {
    const read = () => {
      const id = new URLSearchParams(window.location.search).get("c");
      setActiveThreadId((prev) => (prev === id ? prev : id));
    };
    read();
    const interval = setInterval(read, 1200);
    return () => clearInterval(interval);
  }, []);

  const name = project.name;
  const isUngrouped = !name;
  const label = sectionLabel || projectLabel(name, project.displayName);
  const isActive = activeProject === name;
  const isGhost = !!project.ghost && !isActive && !!name;

  const threads = (isUngrouped
    ? conversations.filter((t) => !t.workspaceName)
    : conversations.filter((t) => t.workspaceName === name)
  )
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const children: BranchedChild[] = threads.slice(0, CAP).map((t) => ({
    value: `thread:${t.id}`,
    label: t.title || "(untitled)",
    title: t.title,
  }));
  if (threads.length >= 5) {
    children.push({
      value: `load:${name || "__ungrouped__"}`,
      label: "Load threads…",
    });
  }
  if (children.length === 0) {
    // Keep the branch expandable so the empty state reads in-tree.
    children.push({ value: `empty:${name || "__ungrouped__"}`, label: "No threads yet" });
  }

  const item: BranchedItem = {
    value: `project:${name || "__ungrouped__"}`,
    label,
    icon: <MsIcon name={isActive ? "folder_open" : "folder"} size={15} />,
    badge: isGhost ? <span className="project-ghost-hint">not on this device</span> : undefined,
    title: isGhost
      ? `${label} — not on this device (use Open to locate it)`
      : isActive
        ? `${label} is the active workspace`
        : `Expand ${label}`,
    children,
  };

  const activeThreadValue = activeThreadId ? `thread:${activeThreadId}` : "";

  return (
    <BranchedMenu
      className="project-branch"
      items={[item]}
      defaultOpen={expanded ? [0] : [-1]}
      defaultActive={activeThreadValue}
      accentColor="#ff6b00"
      // No color/lineColor: theme-aware ink/line come from BranchedMenu.css
      // (dark defaults + html:not(.dark) light overrides) — passing them here
      // would inline dark-only values and break light mode.
      width={224}
      rowHeight={30}
      indent={36}
      trunk={12}
      radius={8}
      fontSize={12.5}
      onSelect={(value) => {
        if (value.startsWith("thread:")) {
          onOpenThread(value.slice(7));
        } else if (value.startsWith("load:")) {
          const target = value.slice(5);
          window.location.assign(
            target === "__ungrouped__" ? "/history?workspace=__ungrouped__" : `/history?workspace=${encodeURIComponent(target)}`
          );
        } else if (value.startsWith("empty:")) {
          // Empty-state row: act like toggling the branch (nothing to open).
        } else if (value.startsWith("project:")) {
          // Header row click: Ungrouped just toggles; real projects reopen.
          if (isUngrouped) onToggle("__ungrouped__");
          else onReopen(name);
        }
      }}
      onToggle={() => onToggle(name || "__ungrouped__")}
      onHeadContextMenu={(_i, anchor) => {
        if (!isUngrouped) onContextMenu(project, anchor);
      }}
    />
  );
}
