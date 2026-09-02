"use client";

import { useState, useEffect, useCallback, useRef, Component, type ReactNode } from "react";
import { useFileSystemContext } from "./FileSystemProvider";
import { useBackgroundChat } from "@/hooks/useBackgroundChat";
import DiffView from "./DiffView";

type Tab = "queue" | "changes" | "files" | "preview" | "terminal";

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
        <div className="rp-empty" style={{ padding: 16 }}>
          <div style={{ color: '#ef4444', marginBottom: 8, fontWeight: 600 }}>⚠️ Tab error</div>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 8, wordBreak: 'break-word' }}>{this.state.error}</div>
          {this.state.errorInfo && (
            <details style={{ fontSize: 11, color: '#999', marginBottom: 8 }}>
              <summary style={{ cursor: 'pointer' }}>Stack trace</summary>
              <pre style={{ marginTop: 4, whiteSpace: 'pre-wrap', fontSize: 10 }}>{this.state.errorInfo}</pre>
            </details>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => this.setState({ error: null, errorInfo: null })} style={{ color: '#a04100', background: 'none', border: '1px solid #a04100', borderRadius: 4, padding: '4px 12px', cursor: 'pointer', fontSize: 12 }}>Retry</button>
            <button onClick={() => { navigator.clipboard?.writeText(`${this.state.error}\n${this.state.errorInfo || ''}`); }} style={{ color: '#666', background: 'none', border: '1px solid #ddd', borderRadius: 4, padding: '4px 12px', cursor: 'pointer', fontSize: 12 }}>Copy error</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

interface RightPanelProps {
  open: boolean;
  onClose: () => void;
  defaultTab?: Tab;
}

// === Queue Tab ===
function QueueTab() {
  const { task } = useBackgroundChat();
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

// === Changes Tab ===
interface ChangeItem {
  path: string;
  timestamp: number;
  isNew: boolean;
  diff: string;
  lineCount: number;
}

function ChangesTab() {
  const [changes, setChanges] = useState<ChangeItem[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [appliedNote, setAppliedNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch("/api/agent/changes");
        const data = await res.json();
        if (alive && data.changes) setChanges(data.changes);
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 3000); // poll every 3s
    return () => { alive = false; clearInterval(interval); };
  }, []);

  if (changes.length === 0) {
    return <div className="rp-empty">No file changes yet — changes appear here as the agent writes files</div>;
  }

  return (
    <div className="rp-changes">
      {changes.map((c, i) => {
        const timeAgo = getTimeAgo(c.timestamp);
        const isExpanded = expanded === i;
        return (
          <div key={i} className="rp-change-card">
            <div className="rp-change-header" onClick={() => setExpanded(isExpanded ? null : i)}>
              <span className={`rp-change-badge ${c.isNew ? "rp-change-new" : "rp-change-mod"}`}>
                {c.isNew ? "+" : "M"}
              </span>
              <span className="rp-change-path" title={c.path}>{c.path.split("/").pop()}</span>
              <span className="rp-change-meta">{c.lineCount}L</span>
              <span className="rp-change-time">{timeAgo}</span>
              <span className="rp-change-expand">{isExpanded ? "-" : "+"}</span>
            </div>
            {isExpanded && (
              <div className="rp-change-diff-wrap">
                <DiffView
                  diff={c.diff}
                  readOnly={false}
                  maxHeight={320}
                  onApply={async (filteredDiff, accepted, rejected) => {
                    // Trigger automatic rollback via file-history when hunks are rejected
                    const { applyHunkDecisions } = window as any;
                    await applyHunkDecisions?.(c.path, filteredDiff, [...accepted], [...rejected]);
                    const fileName = c.path.split("/").pop();
                    if (rejected.size > 0) {
                      setAppliedNote(
                        `Rolled back ${fileName} — ${rejected.size} hunk(s) rejected`
                      );
                    } else {
                      setAppliedNote(
                        `Applied ${accepted.size} hunk(s) to ${fileName}`
                      );
                    }
                    setTimeout(() => setAppliedNote(null), 4000);
                  }}
                  onHunkComment={(hunkId, comment) => {
                    const { submitHunkComment } = window as any;
                    submitHunkComment?.(c.path, hunkId, comment);
                  }}
                />
                {appliedNote && <div className="rp-change-applied">{appliedNote}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function getTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

// === Files Tab ===
function FilesTab() {
  const { fileTree, activeFilePath, setActiveFilePath, readFile, directoryName } = useFileSystemContext();
  const [filter, setFilter] = useState("");

  const filteredTree = fileTree.filter(n =>
    n.name.toLowerCase().includes(filter.toLowerCase())
  );

  const noFolder = !directoryName && fileTree.length === 0;

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

// === Preview Tab (live browser iframe) ===
// Global ref for the screenshot tool — stored in a module-level WeakRef-safe variable
let _previewIframeEl: HTMLIFrameElement | null = null;
export function getPreviewIframe() { return _previewIframeEl; }

function PreviewTab() {
  const [url, setUrl] = useState("");
  const [inputUrl, setInputUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [agentDriven, setAgentDriven] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Register global ref for the screenshot tool — cleaned up on unmount
  useEffect(() => {
    _previewIframeEl = iframeRef.current;
    return () => { _previewIframeEl = null; };
  }, []);

  // Live agent preview: when the agent calls preview_browser or
  // take_screenshot, navigate this iframe to the target URL.
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let alive = true;
    import("@/lib/background-worker").then(({ onPreviewEvent }) => {
      if (!alive) return;
      unsubscribe = onPreviewEvent((event) => {
        setUrl(event.url);
        setInputUrl(event.url);
        setAgentDriven(true);
        setLoading(true);
      });
    }).catch(() => {});
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);

  const navigate = useCallback((target?: string) => {
    const u = (target || inputUrl).trim();
    if (!u) return;
    setError("");
    setLoading(true);
    setAgentDriven(false);
    const full = u.startsWith("http") ? u : `http://${u}`;
    setInputUrl(full);
    setUrl(full);
  }, [inputUrl]);

  return (
    <div className="rp-preview">
      <div className="rp-preview-bar">
        <span className="rp-preview-lock" title="Navigate">{'>'}</span>
        <input
          className="rp-preview-url"
          value={inputUrl}
          onChange={e => setInputUrl(e.target.value)}
          onKeyDown={e => e.key === "Enter" && navigate()}
          placeholder="localhost:3000"
        />
        {agentDriven && !loading && (
          <span className="rp-preview-agent-badge" title="The agent navigated to this page">agent</span>
        )}
        {loading && <span className="rp-preview-loading">...</span>}
      </div>
      {error && <div className="rp-preview-error">{error}</div>}
      <div className="rp-preview-viewport">
        {url ? (
          <iframe
            ref={iframeRef}
            src={url}
            className="rp-preview-iframe"
            onLoad={() => setLoading(false)}
            onError={() => { setLoading(false); setError("Failed to load"); }}
            sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
            title="Browser Preview"
          />
        ) : (
          <div className="rp-preview-empty">
            <div className="rp-preview-empty-icon">{'>'}</div>
            <div className="rp-preview-empty-title">Browser Preview</div>
            <div className="rp-preview-empty-hint">Enter a URL above or let the AI open one</div>
            <div className="rp-preview-empty-ports">
              <button className="rp-preview-port-btn" onClick={() => navigate("http://localhost:3000")}>3000</button>
              <button className="rp-preview-port-btn" onClick={() => navigate("http://localhost:5173")}>5173</button>
              <button className="rp-preview-port-btn" onClick={() => navigate("http://localhost:8080")}>8080</button>
              <button className="rp-preview-port-btn" onClick={() => navigate("http://localhost:4200")}>4200</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// === Terminal Tab (SSE streaming) ===
interface TerminalLine {
  type: "cmd" | "stdout" | "stderr" | "info" | "error" | "done";
  text: string;
  ts?: number;
}

function TerminalTab() {
  const [lines, setLines] = useState<TerminalLine[]>([
    { type: "info", text: "$ Orplex Terminal — streaming output", ts: Date.now() },
    { type: "info", text: "Type a command and press Enter. Up/Down for history.", ts: Date.now() },
  ]);
  const [cmd, setCmd] = useState("");
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll to bottom on new lines
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines]);

  const clearTerminal = () => {
    setLines([{ type: "info", text: "Terminal cleared.", ts: Date.now() }]);
  };

  const runCmd = async () => {
    if (!cmd.trim() || running) return;
    const command = cmd.trim();
    setCmd("");
    setRunning(true);
    setHistory(prev => [...prev, command]);
    setHistoryIdx(-1);
    setLines(prev => [...prev, { type: "cmd", text: `$ ${command}`, ts: Date.now() }]);

    try {
      const res = await fetch("/api/agent/terminal/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setLines(prev => [...prev, { type: "error", text: err.error || `HTTP ${res.status}`, ts: Date.now() }]);
        setRunning(false);
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const event of events) {
          let eventType = "";
          let eventData = "";
          for (const line of event.split("\n")) {
            if (line.startsWith("event: ")) eventType = line.slice(7);
            if (line.startsWith("data: ")) eventData = line.slice(6);
          }

          if (eventType === "stdout" && eventData) {
            setLines(prev => [...prev, { type: "stdout", text: eventData }]);
          } else if (eventType === "stderr" && eventData) {
            setLines(prev => [...prev, { type: "stderr", text: eventData }]);
          } else if (eventType === "done") {
            try {
              const result = JSON.parse(eventData);
              const exitCode = result.code;
              if (exitCode !== 0 && exitCode !== null) {
                setLines(prev => [...prev, { type: "error", text: `exit code ${exitCode}`, ts: Date.now() }]);
              }
            } catch {}
            setLines(prev => [...prev, { type: "done", text: "", ts: Date.now() }]);
          } else if (eventType === "error") {
            setLines(prev => [...prev, { type: "error", text: eventData, ts: Date.now() }]);
          }
        }
      }
    } catch (err) {
      setLines(prev => [...prev, { type: "error", text: (err as Error).message, ts: Date.now() }]);
    }
    setRunning(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runCmd();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      const newIdx = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(newIdx);
      setCmd(history[newIdx]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIdx === -1) return;
      const newIdx = historyIdx + 1;
      if (newIdx >= history.length) {
        setHistoryIdx(-1);
        setCmd("");
      } else {
        setHistoryIdx(newIdx);
        setCmd(history[newIdx]);
      }
    } else if (e.key === "Escape") {
      if (abortRef.current) abortRef.current.abort();
      setRunning(false);
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      clearTerminal();
    }
  };

  return (
    <div className="rp-terminal">
      <div className="rp-terminal-header">
        <span className="rp-terminal-title">Terminal</span>
        <div className="rp-terminal-actions">
          {running && <span className="rp-terminal-badge">running</span>}
          <button className="rp-terminal-clear" onClick={clearTerminal} title="Clear (Ctrl+L)">clear</button>
        </div>
      </div>
      <div className="rp-terminal-output" ref={outputRef}>
        {lines.map((line, i) => (
          <div key={i} className={`rp-terminal-line rp-term-${line.type}`}>
            {line.type === "cmd" && <span className="rp-terminal-prompt-char">$</span>}
            {line.type === "stderr" && <span className="rp-terminal-prompt-char">!</span>}
            {line.type === "error" && <span className="rp-terminal-prompt-char">x</span>}
            <span className="rp-terminal-text">{line.text}</span>
          </div>
        ))}
        {running && <div className="rp-terminal-cursor" />}
      </div>
      <div className="rp-terminal-input-row">
        <span className="rp-terminal-prompt">$</span>
        <input
          ref={inputRef}
          className="rp-terminal-input"
          value={cmd}
          onChange={e => setCmd(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={running ? "running..." : "Enter command..."}
          autoFocus
        />
      </div>
    </div>
  );
}

// === Main Component ===
export default function RightPanel({ open, onClose, defaultTab }: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>(defaultTab || "files");

  // Sync tab when defaultTab changes (e.g. from Ctrl+T)
  useEffect(() => {
    if (defaultTab) setActiveTab(defaultTab);
  }, [defaultTab]);

  if (!open) return null;

  const tabs: { id: Tab; label: string; dot?: boolean }[] = [
    { id: "queue", label: "Queue" },
    { id: "changes", label: "Changes" },
    { id: "files", label: "Files" },
    { id: "preview", label: "Preview", dot: true },
    { id: "terminal", label: "Terminal" },
  ];

  return (
    <aside className="right-panel" style={{ position: "fixed", top: 64, right: 0, bottom: 0, width: "min(320px, 100vw)", zIndex: 35 }}>
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
          {activeTab === "preview" && <PreviewTab />}
          {activeTab === "terminal" && <TerminalTab />}
        </TabErrorBoundary>
      </div>
    </aside>
  );
}
