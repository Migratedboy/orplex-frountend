"use client";

// WorkspaceSwitcher — the Freebuff-style workspace affordance above the
// prompt bar: a small chip ("<folder> ⌄") that opens a menu with
// "+ Open project..." (the folder picker) and one row per known project.
// Clicking a project re-attaches it (permission prompt → tree + cwd switch).
// The roster comes from WorkspaceProvider — the single owner shared with the
// sidebar, so re-attaching here updates the sidebar's Projects section too.

import { useEffect, useRef, useState } from "react";
import { IconFolder, IconFolderOpen, IconChevronDown, IconPlus } from "./Icons";
import { useFileSystemContext } from "./FileSystemProvider";
import { useWorkspace } from "./WorkspaceProvider";
import { projectLabel } from "@/lib/project-threads";
import type { ProjectEntry } from "@/lib/project-registry";

export default function WorkspaceSwitcher() {
  const { directoryName, openFolder, reopenProject } = useFileSystemContext();
  const { projects } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [reopening, setReopening] = useState<string | null>(null);
  const [recent, setRecent] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const reopen = async (project: ProjectEntry) => {
    if (reopening) return; // one permission prompt at a time
    setReopening(project.name);
    try {
      const outcome = await reopenProject(project.name);
      if (outcome.status === "ok") {
        setOpen(false);
        setRecent(project.name);
      }
    } finally {
      setReopening(null);
    }
  };

  // Active chip label: the open folder, else the last context (marker row),
  // else "project".
  const label = directoryName ?? recent ?? "project";

  return (
    <div className="ws-switcher" ref={wrapRef}>
      <button
        type="button"
        className="ws-chip"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        title={directoryName ? `Workspace: ${directoryName}` : "Choose a workspace folder"}
      >
        <IconFolderOpen size={14} />
        <span className="ws-chip-label">{label}</span>
        <IconChevronDown size={12} />
      </button>
      {open && (
        <div className="ws-menu" role="menu">
          <button
            type="button"
            className="ws-menu-item ws-menu-open"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              openFolder();
            }}
          >
            <IconPlus size={14} />
            <span>Open project...</span>
          </button>
          {projects.length > 0 && <div className="ws-menu-sep" />}
          {projects.map((project) => (
            <button
              key={project.name}
              type="button"
              className={`ws-menu-item ${directoryName === project.name ? "ws-menu-active" : ""} ${project.ghost ? "ws-menu-ghost" : ""}`}
              role="menuitem"
              disabled={reopening === project.name}
              onClick={() => reopen(project)}
              title={project.ghost ? "Opened on another device — use Open project... to re-attach" : project.lastPath}
            >
              <IconFolder size={14} />
              <span className="ws-menu-name">{projectLabel(project.name, project.displayName)}</span>
              {directoryName === project.name && <span className="ws-menu-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
