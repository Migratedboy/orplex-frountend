"use client";

import { useState, useEffect, useRef, Component, type ReactNode } from "react";
import { useFileSystemContext } from "./FileSystemProvider";
import { useBackgroundChat } from "@/hooks/useBackgroundChat";
import { useScratchpad } from "@/hooks/useScratchpad";
import { ErrorView } from "./StateViews";
import { QueuePanelSkeleton, FilesPanelSkeleton } from "./PanelSkeletons";
import { ChangesTab } from "./right-panel/changes-tab";
import BrowserPreview, { mountedBrowserRef } from "./right-panel/preview-tab";
import { TerminalTab } from "./right-panel/terminal-tab";

type Tab = "queue" | "changes" | "files" | "preview" | "terminal" | "scratch";

// Error boundary to prevent one tab crash from killing the whole panel
class TabErrorBoundary extends Component<{ children: ReactNode; tab: string }, { error: string | null; errorInfo: string | null }> {
  state = { error: null as string | null, errorInfo: null as string | null };
  static getDerivedStateFromError(err: Error) { return { error: err.message }; }
  componentDidCatch(err: Error, info: React.ErrorInfo) {
    this.setState({ errorInfo: info.componentStack || null });
    console.error(`[TabErrorBoundary:${this.props.tab}]`, err, info);
  }
  render() {
    if (this.state.error) {
      return (
        <ErrorView
          error={this.state.error}
          title="Tab error"
          retry={() => this.setState({ error: null, errorInfo: null })}
          className="rp-empty"
        />
      );
    }
    return this.props.children;
  }
}

interface RightPanelProps {
  open: boolean;
  onClose: () => void;
  defaultTab?: Tab;
  onResizingChange?: (resizing: boolean) => void;
}

// === Queue Tab ===
function QueueTab() {
  const { task } = useBackgroundChat();
  // Skeleton only while the first read is in flight. useBackgroundChat starts
  // with task === undefined, which is indistinguishable from "no task" — showing
  // the skeleton on a genuine no-task state would leave it spinning forever, so
  // the skeleton is confined to the very first paint.
  const firstPaint = useRef(true);
  useEffect(() => { firstPaint.current = false; }, []);
  if (!task && firstPaint.current) return <QueuePanelSkeleton />;
  if (!task) return <div className="rp-empty">No active tasks</div>;

  const statusColor = task.status === "done" ? "#22c55e" : task.status === "error" ? "#ef4444" : "#f97316";

  return (
    <div className="rp-queue">
      <div className="rp-queue-item">
        <div className="rp-queue-dot" style={{ background: statusColor }} />
        <div className="rp-queue-info">
          <span className="rp-queue-msg">{task.userMessage.slice(0, 60)}{task.userMessage.length > 60 ? "..." : ""}</span>
          <span className="rp-queue-status">{task.statusDetail || task.status}</span>
        </div>
      </div>
    </div>
  );
}


// === Files Tab ===
function FilesTab() {
  const { fileTree, activeFilePath, setActiveFilePath, readFile, directoryName } = useFileSystemContext();
  const [filter, setFilter] = useState("");

  const filteredTree = fileTree.filter(n =>
    n.name.toLowerCase().includes(filter.toLowerCase())
  );

  const noFolder = !directoryName && fileTree.length === 0;

  // A folder can be mapped while its tree is still streaming in. Render the
  // skeleton until the first non-empty tree lands so the panel doesn't show
  // "No files found" for a second and then snap to the real listing.
  const [treeSettled, setTreeSettled] = useState(false);
  useEffect(() => { if (fileTree.length > 0) setTreeSettled(true); }, [fileTree.length]);
  if (!noFolder && !treeSettled) return <FilesPanelSkeleton />;

  return (
    <div className="rp-files">
      <div className="rp-files-search">
        <input
          className="rp-files-input"
          placeholder="Filter files"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      </div>
      <div className="rp-files-tree">
        {noFolder ? (
          <div className="rp-empty">No folder opened — use Open in the sidebar</div>
        ) : (
          <>
            {filteredTree.map(node => (
              <FileNodeItem key={node.path} node={node} depth={0} filter={filter} onSelect={(path) => {
                setActiveFilePath(path);
                readFile(path);
              }} activePath={activeFilePath} />
            ))}
            {filteredTree.length === 0 && <div className="rp-empty">No files found</div>}
          </>
        )}
      </div>
    </div>
  );
}

function FileNodeItem({ node, depth, filter, onSelect, activePath }: {
  node: any; depth: number; filter: string; onSelect: (path: string) => void; activePath: string | null;
}) {
  const [collapsed, setCollapsed] = useState(depth > 0);
  const isActive = activePath === node.path;

  if (node.kind === "directory") {
    const children = node.children?.filter((c: any) =>
      c.name.toLowerCase().includes(filter.toLowerCase())
    ) || [];
    return (
      <div>
        <div
          className={`rp-file-item ${isActive ? "rp-file-active" : ""}`}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          onClick={() => setCollapsed(!collapsed)}
        >
          <span className="rp-file-arrow">{collapsed ? ">" : "v"}</span>
          <span className="rp-file-name">{node.name}</span>
        </div>
        {!collapsed && children.map((child: any) => (
          <FileNodeItem key={child.path} node={child} depth={depth + 1} filter={filter} onSelect={onSelect} activePath={activePath} />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`rp-file-item ${isActive ? "rp-file-active" : ""}`}
      style={{ paddingLeft: `${depth * 14 + 8}px` }}
      onClick={() => onSelect(node.path)}
    >
      <span className="rp-file-icon">-</span>
      <span className="rp-file-name">{node.name}</span>
    </div>
  );
}



// === Scratch Tab — live mirror of the agent's private working memory ===
function ScratchTab() {
  const { text, live } = useScratchpad();
  if (!text) {
    return (
      <div className="rp-empty">
        No scratchpad yet — it appears here while the agent works a task.
      </div>
    );
  }
  // Render plan/hypotheses/findings/next as headed blocks; fall back to raw.
  const lines = text.replace(/^<scratchpad>\n?/, "").replace(/\n?<\/scratchpad>$/, "").split("\n");
  const blocks: Array<{ head: string; body: string }> = [];
  let cur: { head: string; body: string } | null = null;
  for (const line of lines) {
    const m = line.match(/^(plan|hypotheses|findings|next):\s?(.*)$/);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { head: m[1], body: m[2] };
    } else if (cur) {
      cur.body += (cur.body ? "\n" : "") + line;
    }
  }
  if (cur) blocks.push(cur);
  return (
    <div className="rp-scratch">
      {!live && <div className="rp-scratch-stale">Last session — read-only snapshot</div>}
      {blocks.length > 0 ? (
        blocks.map((b, i) => (
          <div key={i} className="rp-scratch-block">
            <div className="rp-scratch-head">{b.head}</div>
            <div className="rp-scratch-body">{b.body || <span className="rp-scratch-empty">—</span>}</div>
          </div>
        ))
      ) : (
        <pre className="rp-scratch-raw">{text}</pre>
      )}
    </div>
  );
}

// === Main Component ===
export default function RightPanel({ open, onClose, defaultTab, onResizingChange }: RightPanelProps) {
  // Storage reads happen in effects, NOT in useState initializers — the
  // server renders the defaults and a client-side restore would be a
  // hydration mismatch (React error #418).
  const [activeTab, setActiveTab] = useState<Tab>(defaultTab || "files");
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem("orplex.rightPanelTab");
      if (saved && ["queue", "changes", "files", "preview", "terminal", "scratch"].includes(saved)) {
        setActiveTab(saved as Tab);
      }
    } catch {}
    // Run once after hydration.

  }, []);

  // Sync tab when defaultTab changes (e.g. from Ctrl+T) + persist choice
  useEffect(() => {
    if (defaultTab) setActiveTab(defaultTab);
  }, [defaultTab]);
  useEffect(() => {
    try { sessionStorage.setItem("orplex.rightPanelTab", activeTab); } catch {}
  }, [activeTab]);

  // === Resize (drag the left grip) ===
  // Width is persisted and published as --rp-w so the main-content margins
  // follow the panel automatically.
  // Panel width lives IN CODE (no persistence): 620px out of the box — a
  // real browser width for the preview. Dragging resizes for the session;
  // reload always returns to the coded default.
  const DEFAULT_RP_WIDTH = 620;
  const [width, setWidth] = useState<number>(DEFAULT_RP_WIDTH);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragStart = useRef({ x: 0, w: 0 });

  useEffect(() => {
    document.documentElement.style.setProperty("--rp-w", `${Math.round(width)}px`);
  }, [width]);

  useEffect(() => {
    onResizingChange?.(resizing);
    return () => onResizingChange?.(false);
    // onResizingChange is a setState passed from AppLayout, so it is stable;
    // this stays scoped to actual resizing start/stop transitions.
  }, [resizing, onResizingChange]);

  useEffect(() => {
    if (!resizing) return undefined;
    // Freeze text selection + show the resize cursor for the whole drag.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onPointerMove = (e: PointerEvent) => {
      const max = Math.min(720, window.innerWidth - 320);
      // Clamp the max FIRST, then enforce the 280 floor — on narrow windows
      // max can drop below the floor and must not shrink the panel.
      const next = Math.max(280, Math.min(max, dragStart.current.w + (dragStart.current.x - e.clientX)));
      setWidth(next);
    };
    const stop = () => {
      setResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [resizing]);

  if (!open) return null;

  const tabs: { id: Tab; label: string; dot?: boolean }[] = [
    { id: "queue", label: "Queue" },
    { id: "changes", label: "Changes" },
    { id: "files", label: "Files" },
    { id: "preview", label: "Preview", dot: true },
    { id: "terminal", label: "Terminal" },
    { id: "scratch", label: "Scratch" },
  ];

  return (
    <aside
      className="right-panel"
      style={{ position: "fixed", top: 64, right: 0, bottom: 0, width: "min(var(--rp-w, 620px), 100vw)", zIndex: 35 }}
      data-resizing={resizing ? "" : undefined}
    >
      {/* Resize grip — drag to resize, double-click to reset, arrows for keyboard */}
      <div
        className="rp-resize-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        title="Drag to resize · double-click to reset"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          dragStart.current = { x: e.clientX, w: widthRef.current };
          try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
          setResizing(true);
        }}
        onDoubleClick={() => setWidth(DEFAULT_RP_WIDTH)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 40 : 16;
          const max = Math.min(720, window.innerWidth - 320);
          if (e.key === "ArrowLeft") { e.preventDefault(); setWidth(w => Math.max(280, Math.min(max, w + step))); }
          if (e.key === "ArrowRight") { e.preventDefault(); setWidth(w => Math.max(280, Math.min(max, w - step))); }
        }}
        tabIndex={0}
      />
      <div className="rp-tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`rp-tab ${activeTab === tab.id ? "rp-tab-active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
            {tab.dot && <span className="rp-tab-dot" />}
          </button>
        ))}
        <button className="rp-close" onClick={onClose} title="Close panel">x</button>
      </div>
      <div className="rp-content">
        <TabErrorBoundary tab={activeTab}>
          {activeTab === "queue" && <QueueTab />}
          {activeTab === "changes" && <ChangesTab />}
          {activeTab === "files" && <FilesTab />}
          {/* Native preview views can't be hidden by CSS — keep mounted and
              toggle their visibility via preview:showTab on prop change. */}
          {(activeTab === "preview" || mountedBrowserRef.current) && (
            // height:100% keeps the flex chain intact — .rp-browser sizes
            // against .rp-content exactly as it did as a direct child.
            <div
              style={{
                height: "100%",
                display: activeTab === "preview" ? undefined : "none",
              }}
            >
              <BrowserPreview panelActive={activeTab === "preview" && open} />
            </div>
          )}
          {activeTab === "terminal" && <TerminalTab />}
          {activeTab === "scratch" && <ScratchTab />}
        </TabErrorBoundary>
      </div>
    </aside>
  );
}
