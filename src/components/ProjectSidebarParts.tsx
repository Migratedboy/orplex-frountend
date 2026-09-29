// ProjectSidebarParts.tsx — the Projects sidebar's presentational parts,
// extracted from Sidebar.tsx (which keeps only layout + wiring):
//   ProjectContextMenu — right-click menu (clamp positioning, keyboard,
//                        two-step destructive confirm, inline rename editor)
//   ProjectRenameInput — inline alias editor inside the menu
//   ProjectRow         — one collapsible project row with its threads
"use client";

import { useState, useEffect, useRef } from "react";
import { IconFolder, IconFolderOpen, IconChevronDown, IconChevronRight } from "./Icons";
import { buildProjectMenu, clampMenuPosition, type ConfirmState, type ProjectMenuItemId } from "@/lib/project-menu";
import { projectLabel, historyLinkFor, type ThreadLike } from "@/lib/project-threads";
import type { ProjectEntry } from "@/lib/project-registry";

// Per-project right-click menu (positioned via the pure clamp helper, with
// the two-step confirm for the destructive item and an inline rename editor).
// Keyboard: Esc closes (disarming an armed confirm), ↓/↑ move among enabled
// items, Enter activates, R focuses the rename input.
export function ProjectContextMenu({
  project,
  anchor,
  isActive,
  confirmState,
  onAction,
  onDismiss,
}: {
  project: ProjectEntry;
  anchor: { x: number; y: number };
  isActive: boolean;
  confirmState: ConfirmState;
  onAction: (id: ProjectMenuItemId, project: ProjectEntry) => void;
  onDismiss: () => void;
}) {
  const hasBridge = typeof window !== "undefined" && !!window.orplexDesktop;
  const items = buildProjectMenu({
    canReveal: !!project.lastPath,
    isGhost: !!project.ghost,
    isActive,
    hasDesktopBridge: hasBridge,
  });
  const pos = typeof window !== "undefined" ? clampMenuPosition(anchor, { width: window.innerWidth, height: window.innerHeight }) : anchor;
  const label = projectLabel(project.name, project.displayName);
  const [renaming, setRenaming] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Esc closes the menu (cancelling an armed confirm / open rename editor).
  // Arrow keys walk enabled items; Enter activates the focused one; R jumps
  // to the rename editor.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (renaming) return; // the input handles its own keys
    if (e.key === "Escape") {
      e.preventDefault();
      onDismiss();
      return;
    }
    if (e.key === "r" || e.key === "R") {
      const renameItem = items.find((i) => i.id === "rename");
      if (renameItem?.enabled) {
        e.preventDefault();
        setRenaming(true);
      }
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
    e.preventDefault();
    const menu = menuRef.current;
    if (!menu) return;
    const focusables = Array.from(menu.querySelectorAll<HTMLButtonElement>(".ctx-item:not(.ctx-item-disabled)"));
    if (focusables.length === 0) return;
    const idx = focusables.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Enter") {
      (document.activeElement as HTMLButtonElement | null)?.click();
    } else {
      const next = e.key === "ArrowDown"
        ? focusables[(idx + 1 + focusables.length) % focusables.length]
        : focusables[(idx - 1 + focusables.length) % focusables.length];
      (next as HTMLButtonElement | undefined)?.focus();
    }
  };

  return (
    <div className="ctx-overlay" onClick={onDismiss} onContextMenu={(e) => { e.preventDefault(); onDismiss(); }}>
      <div
        ref={menuRef}
        className="ctx-menu"
        style={{ left: pos.x, top: pos.y }}
        role="menu"
        aria-label={`Project menu: ${label}`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item) => {
          if (item.id === "rename" && renaming) {
            return (
              <ProjectRenameInput
                key="rename-input"
                projectName={project.name}
                currentAlias={project.displayName}
                onCommit={(alias) => {
                  setRenaming(false);
                  onAction("rename", { ...project, displayName: alias || undefined });
                }}
                onCancel={() => setRenaming(false)}
              />
            );
          }
          if (item.id === "remove-and-delete" && confirmState === "armed") {
            return (
              <button
                key={item.id}
                role="menuitem"
                className="ctx-item ctx-item-danger ctx-item-confirm"
                title="Click again to permanently delete these threads"
                onClick={() => onAction("remove-and-delete", project)}
              >
                Really delete threads?
              </button>
            );
          }
          return (
            <button
              key={item.id}
              role="menuitem"
              className={`ctx-item ${item.id === "remove-and-delete" ? "ctx-item-danger" : ""} ${!item.enabled ? "ctx-item-disabled" : ""}`}
              disabled={!item.enabled}
              title={item.enabled ? undefined : item.reason}
              onClick={() => {
                if (!item.enabled) return;
                // Rename opens the inline editor IN the menu; everything else
                // goes to the owner's action handler.
                if (item.id === "rename") setRenaming(true);
                else onAction(item.id, project);
              }}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Inline rename editor inside the context menu: pre-filled with the current
// alias, Enter/blur commits (via setProjectAlias in the action handler), Esc
// cancels. Replaces the old window.prompt() dialog.
function ProjectRenameInput({
  projectName,
  currentAlias,
  onCommit,
  onCancel,
}: {
  projectName: string;
  currentAlias?: string;
  onCommit: (alias: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(currentAlias || "");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      className="ctx-rename-input"
      value={value}
      placeholder={projectName}
      maxLength={120}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
      onBlur={() => onCommit(value)}
      aria-label={`Display name for ${projectName}`}
    />
  );
}

// One collapsible project row (chevron + folder icon + name) with its
// threads when expanded. Matches the reference screenshot: chevron toggles
// expand; clicking the NAME re-attaches the folder as the active workspace.
export function ProjectRow({
  project,
  active,
  expanded,
  onToggle,
  onReopen,
  onOpenThread,
  threads,
  onContextMenu,
}: {
  project: ProjectEntry;
  active: boolean;
  expanded: boolean;
  onToggle: () => void;
  onReopen: () => void;
  onOpenThread: (id: string) => void;
  threads: ThreadLike[];
  onContextMenu?: (anchor: { x: number; y: number }) => void;
}) {
  const label = projectLabel(project.name, project.displayName);
  // Ghost = roster knows it but this device has no handle. The Ungrouped row
  // (empty name) is a pure collapsible — never ghost-styled.
  const isGhost = !!project.ghost && !active && !!project.name;

  return (
    <div
      className={`project-row ${active ? "project-row-active" : ""} ${isGhost ? "project-row-ghost" : ""}`}
      onContextMenu={
        // Ungrouped is not a project — no menu (and no preventDefault, so the
        // native menu still works there); real rows open the project menu.
        project.name && onContextMenu
          ? (e) => {
              e.preventDefault();
              onContextMenu({ x: e.clientX, y: e.clientY });
            }
          : undefined
      }
    >
      <div
        className="project-row-head"
        onTouchStart={(e) => {
          const touch = e.touches[0];
          if (!touch || !onContextMenu) return;
          const el = e.currentTarget;
          el.dataset.longPressArmed = "1";
          el.dataset.startX = String(touch.clientX);
          el.dataset.startY = String(touch.clientY);
          (el as any)._lpTimer = window.setTimeout(() => {
            if (el.dataset.longPressArmed === "1") {
              el.dataset.longPressArmed = "0";
              onContextMenu({ x: Number(el.dataset.startX), y: Number(el.dataset.startY) });
            }
          }, 550);
        }}
        onTouchMove={(e) => {
          const touch = e.touches[0];
          const el = e.currentTarget;
          if (touch && el.dataset.startX) {
            const dx = Math.abs(touch.clientX - Number(el.dataset.startX));
            const dy = Math.abs(touch.clientY - Number(el.dataset.startY));
            if (dx > 10 || dy > 10) el.dataset.longPressArmed = "0"; // scrolled — cancel
          }
        }}
        onTouchEnd={(e) => {
          const el = e.currentTarget;
          el.dataset.longPressArmed = "0";
          window.clearTimeout((el as any)._lpTimer);
        }}
      >
        <button
          className="project-chevron"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        </button>
        <button
          className="project-name"
          onClick={onReopen}
          title={isGhost ? `${label} — not on this device (use Open to locate it)` : `Switch to "${label}"`}
        >
          <span className="project-folder-icon">{active ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}</span>
          <span className="truncate">{label}</span>
          {isGhost && <span className="project-ghost-hint">not on this device</span>}
        </button>
      </div>
      {expanded && (
        <div className="project-threads">
          {threads.length === 0 ? (
            <div className="project-threads-empty">No threads yet.</div>
          ) : (
            <>
              {threads.map((c) => (
                <button key={c.id} className="project-thread" onClick={() => onOpenThread(c.id)} title={c.title}>
                  {c.title}
                </button>
              ))}
              {threads.length >= 5 && <a className="project-load-threads" href={historyLinkFor(project.name)}>Load threads</a>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
