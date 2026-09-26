"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { IconSearch, IconChat, IconHistory, IconSettings, IconAgent, IconTerminal, IconPlugins } from "./Icons";

import { apiFetch } from "@/lib/api-base";
// === Command model ===

export interface Command {
  id: string;
  label: string;
  hint?: string;
  section: "Navigation" | "Agent Runs" | "Panels" | "Actions";
  icon?: React.ReactNode;
  keywords?: string;
  action: () => void;
}

interface BoardRunSummary {
  id: string;
  prompt: string;
  status: string;
  isActive: boolean;
  estimatedCostLabel: string;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Opens the right panel to a specific tab (wired by AppLayout) */
  onOpenPanel?: (tab: string) => void;
  /** Opens the artifact panel for a run (wired by AppLayout) */
  onOpenRun?: (runId: string) => void;
}

// Flat icon helpers
const NAV_ICONS: Record<string, React.ReactNode> = {
  "/": <IconChat size={14} />,
  "/history": <IconHistory size={14} />,
  "/runs": <IconAgent size={14} />,
  "/plugins": <IconPlugins size={14} />,
  "/settings": <IconSettings size={14} />,
};

export default function CommandPalette({ open, onClose, onOpenPanel, onOpenRun }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [runs, setRuns] = useState<BoardRunSummary[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Reset + focus on open, fetch runs for jump targets
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIdx(0);
    requestAnimationFrame(() => inputRef.current?.focus());
    apiFetch("/api/agent/runs?limit=10")
      .then(r => r.json())
      .then(d => { if (d.success) setRuns(d.runs || []); })
      .catch(() => {});
  }, [open]);

  // Fetch runs periodically while open so active runs stay fresh
  useEffect(() => {
    if (!open) return;
    const interval = setInterval(() => {
      apiFetch("/api/agent/runs?limit=10")
        .then(r => r.json())
        .then(d => { if (d.success) setRuns(d.runs || []); })
        .catch(() => {});
    }, 8000);
    return () => clearInterval(interval);
  }, [open]);

  const close = useCallback(() => onClose(), [onClose]);

  // === Build the command list ===

  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [];

    // Navigation
    const navTargets: Array<[string, string, string]> = [
      ["/", "New Chat", "chat"],
      ["/runs", "Runs Board", "board kanban manager"],
      ["/history", "History", "conversations past"],
      ["/plugins", "Plugins", "extensions"],
      ["/settings", "Settings", "preferences config"],
      ["/admin/system", "System Status", "admin hardware memory janitor pacer watchdog"],
      ["/admin", "Admin Dashboard", "admin keys backups"],
    ];
    for (const [href, label, keywords] of navTargets) {
      cmds.push({
        id: `nav-${href}`,
        label,
        section: "Navigation",
        icon: NAV_ICONS[href],
        keywords,
        action: () => { router.push(href); close(); },
      });
    }

    // Panels
    if (onOpenPanel) {
      const panels: Array<[string, string, string]> = [
        ["files", "Open Files panel", "file tree workspace sidebar"],
        ["changes", "Open Changes panel", "diff review hunks"],
        ["preview", "Open Preview panel", "browser live iframe"],
        ["terminal", "Open Terminal", "shell console"],
        ["queue", "Open Queue panel", "background tasks"],
      ];
      for (const [tab, label, keywords] of panels) {
        cmds.push({
          id: `panel-${tab}`,
          label,
          section: "Panels",
          icon: <IconTerminal size={14} />,
          keywords,
          action: () => { onOpenPanel(tab); close(); },
        });
      }
    }

    // Agent Runs — active first
    for (const run of runs.slice(0, 8)) {
      cmds.push({
        id: `run-${run.id}`,
        label: run.prompt.slice(0, 64) + (run.prompt.length > 64 ? "..." : ""),
        hint: `${run.status}${run.isActive ? " (live)" : ""} - ${run.estimatedCostLabel}`,
        section: "Agent Runs",
        icon: <IconAgent size={14} />,
        keywords: `${run.status} artifacts run`,
        action: () => {
          if (onOpenRun) {
            onOpenRun(run.id);
          } else {
            router.push("/runs");
          }
          close();
        },
      });
    }

    return cmds;
  }, [router, runs, onOpenPanel, onOpenRun, close]);

  // === Filter + keyboard nav ===

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(c =>
      c.label.toLowerCase().includes(q) ||
      c.section.toLowerCase().includes(q) ||
      (c.keywords || "").toLowerCase().includes(q) ||
      (c.hint || "").toLowerCase().includes(q)
    );
  }, [commands, query]);

  // Group by section for rendering
  const grouped = useMemo(() => {
    const groups: Array<{ section: string; items: Command[] }> = [];
    for (const cmd of filtered) {
      const last = groups[groups.length - 1];
      if (last && last.section === cmd.section) last.items.push(cmd);
      else groups.push({ section: cmd.section, items: [cmd] });
    }
    return groups;
  }, [filtered]);

  // Clamp selection
  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  useEffect(() => {
    if (selectedIdx >= filtered.length) setSelectedIdx(Math.max(0, filtered.length - 1));
  }, [filtered.length, selectedIdx]);

  const runCommand = useCallback((cmd: Command) => {
    cmd.action();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[selectedIdx];
      if (cmd) runCommand(cmd);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.querySelector("[data-selected='true']");
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  if (!open) return null;

  let flatIdx = -1;

  return (
    <div className="palette-overlay" onClick={close} role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input-row">
          <IconSearch size={14} className="palette-search-icon" />
          <input
            ref={inputRef}
            className="palette-input"
            placeholder="Jump to a run, panel, or page..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Search commands"
          />
          <kbd className="palette-kbd">esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="palette-empty">No matches for &quot;{query}&quot;</div>
          ) : (
            grouped.map(group => (
              <div key={group.section} className="palette-group">
                <div className="palette-group-label">{group.section}</div>
                {group.items.map(cmd => {
                  flatIdx++;
                  const idx = flatIdx;
                  return (
                    <button
                      key={cmd.id}
                      className={`palette-item ${idx === selectedIdx ? "selected" : ""}`}
                      data-selected={idx === selectedIdx}
                      onMouseEnter={() => setSelectedIdx(idx)}
                      onClick={() => runCommand(cmd)}
                    >
                      <span className="palette-item-icon">{cmd.icon}</span>
                      <span className="palette-item-label">{cmd.label}</span>
                      {cmd.hint && <span className="palette-item-hint">{cmd.hint}</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
