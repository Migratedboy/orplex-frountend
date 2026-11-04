"use client";

/**
 * terminal-tab.tsx — the Terminal tab (SSE streaming), extracted verbatim from
 * RightPanel.tsx (Operation Modularity). Self-contained block: terminal lines,
 * SSE subscription, kill switch. The panel shell keeps tab routing.
 */
import { useState, useEffect, useRef } from "react";
import { useFileSystemContext } from "../FileSystemProvider";

// === Terminal Tab (SSE streaming) ===
interface TerminalLine {
  type: "cmd" | "stdout" | "stderr" | "info" | "error" | "done";
  text: string;
  ts?: number;
}

// Module scope: Date.now() during render trips the purity rule; these lines
// are append-only afterwards (every update spreads into a new array).
const INITIAL_TERMINAL_LINES: TerminalLine[] = [
  { type: "info", text: "$ Orplex Terminal — streaming output", ts: 0 },
  { type: "info", text: "Type a command and press Enter. Up/Down for history.", ts: 0 },
];

export function TerminalTab() {
  const [lines, setLines] = useState<TerminalLine[]>(INITIAL_TERMINAL_LINES);
  const [cmd, setCmd] = useState("");
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  // Warn+confirm state for dangerous manual input (exec-guard refusal).
  const [pendingConfirm, setPendingConfirm] = useState<{ command: string; reason: string } | null>(null);
  // Live servers (desktop lane) with stop buttons.
  const [servers, setServers] = useState<Array<{ id: number; command: string; url: string | null }>>([]);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll to bottom on new lines
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines]);

  const pushLine = (line: TerminalLine) => {
    setLines(prev => {
      const next = [...prev, line];
      // Bounded buffer — a build log must never grow the DOM without limit.
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
  };

  // Agent-run commands land here live (unified terminal event bus).
  useEffect(() => {
    let off: (() => void) | null = null;
    void import("@/lib/terminal-events").then((m) => {
      off = m.onTerminalEvent((ev) => {
        const prefix = ev.source === "agent" ? "[agent] " : "";
        if (ev.type === "cmd") pushLine({ type: "cmd", text: `${prefix}$ ${ev.text.replace(/^\$ /, "")}`, ts: ev.at });
        else if (ev.type === "stdout") pushLine({ type: "stdout", text: `${prefix}${ev.text}`, ts: ev.at });
        else if (ev.type === "stderr") pushLine({ type: "stderr", text: `${prefix}${ev.text}`, ts: ev.at });
        else if (ev.type === "error") pushLine({ type: "error", text: `${prefix}${ev.text}`, ts: ev.at });
        else if (ev.type === "done") pushLine({ type: "done", text: "", ts: ev.at });
        else pushLine({ type: "info", text: `${prefix}${ev.text}`, ts: ev.at });
      });
    }).catch(() => {});
    return () => { try { off?.(); } catch {} };
  }, []);

  // Refresh the live-server badges (desktop lane only).
  const refreshServers = async () => {
    try {
      const { hasDesktopTerminal } = await import("@/lib/terminal-lane");
      if (!hasDesktopTerminal()) return;
      const bridge = window.orplexDesktop!.terminal!;
      const r = await bridge.serveList();
      if (r.ok) setServers((r.servers ?? []).map(s => ({ id: s.id, command: s.command, url: s.url })));
    } catch {}
  };
  useEffect(() => {
    void refreshServers();
    const t = setInterval(() => { void refreshServers(); }, 8000);
    return () => clearInterval(t);

  }, []);

  const clearTerminal = () => {
    setLines([{ type: "info", text: "Terminal cleared.", ts: Date.now() }]);
  };

  // Active folder name → absolute device path for on-device execution.
  const { directoryName: activeDirName } = useFileSystemContext();

  const execManual = async (command: string) => {
    setRunning(true);
    const aborter = new AbortController();
    abortRef.current = aborter;
    try {
      // Shared lane: desktop bridge on-device when present, API session
      // otherwise. The lane also mirrors to the bus — the subscription above
      // paints it, so execManual stays display-free (no double lines).
      const { runTerminalCommand } = await import("@/lib/terminal-lane");
      await runTerminalCommand({
        command,
        dirName: activeDirName ?? undefined,
        signal: aborter.signal,
        source: "user",
        quiet: false,
      });
    } catch (err) {
      pushLine({ type: "error", text: (err as Error).message, ts: Date.now() });
    }
    abortRef.current = null;
    setRunning(false);
    void refreshServers();
  };

  const runCmd = async (force = false) => {
    if (!cmd.trim() || running) return;
    const command = cmd.trim();
    // Warn+confirm: dangerous manual input needs explicit approval first.
    if (!force) {
      try {
        const { screenManualCommand } = await import("@/lib/terminal-lane");
        const verdict = screenManualCommand(command);
        if (!verdict.ok) {
          setPendingConfirm({ command, reason: verdict.reason });
          return;
        }
      } catch {}
    }
    setPendingConfirm(null);
    setCmd("");
    setHistory(prev => [...prev, command]);
    setHistoryIdx(-1);
    await execManual(command);
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
      {servers.length > 0 && (
        <div className="rp-terminal-servers">
          {servers.map(s => (
            <span key={s.id} className="rp-terminal-server" title={s.command}>
              <span className="rp-terminal-server-dot" />{s.url ? s.url.replace("http://", ":") : `#${s.id} ${s.command.slice(0, 24)}`}
              <button
                className="rp-terminal-server-stop"
                title={`Stop server ${s.id}`}
                onClick={async () => {
                  try {
                    const bridge = window.orplexDesktop?.terminal;
                    if (bridge) await bridge.serveStop(s.id);
                  } catch {}
                  void refreshServers();
                }}
              >×</button>
            </span>
          ))}
        </div>
      )}
      {pendingConfirm && (
        <div className="rp-terminal-confirm" role="alert">
          <div className="rp-terminal-confirm-text">Blocked: {pendingConfirm.reason}. Run anyway?</div>
          <div className="rp-terminal-confirm-actions">
            <button className="rp-terminal-confirm-run" onClick={() => void runCmd(true)}>Run anyway</button>
            <button className="rp-terminal-confirm-cancel" onClick={() => setPendingConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}
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
