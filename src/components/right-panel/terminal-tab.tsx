"use client";

/**
 * terminal-tab.tsx — the Terminal tab (SSE streaming). Right Panel v2 (P2):
 * - Reference presentation (monospace surface, accent prompt) with the v1
 *   behaviors preserved: persistent sessions, SSE, kill switch, server chips.
 * - The prompt shows the REAL workspace cwd (resolved via the desktop
 *   bridge), never a hard-coded `PS C:\orplex>` (spec §5.6).
 * - Ctrl+C cancels the running command (Escape still does too).
 * - Scroll-lock: auto-scroll pauses while the user scrolls up.
 * - ANSI escape sequences are stripped before render (safe display).
 */
import { useState, useEffect, useRef } from "react";
import { useFileSystemContext } from "../FileSystemProvider";
import { stripAnsi } from "@/lib/terminal-format";

interface TerminalLine {
  type: "cmd" | "stdout" | "stderr" | "info" | "error" | "done";
  text: string;
  ts?: number;
}

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
  // Scroll-lock: only auto-scroll while pinned to the bottom.
  const atBottomRef = useRef(true);
  // Real workspace cwd for the prompt (absolute path via desktop bridge).
  const [cwdLabel, setCwdLabel] = useState<string>("");

  // Resolve the absolute workspace path once per open-folder change. The
  // bridge resolves a folder NAME to the device path the shell actually runs
  // in (same source the session lane uses — workspace-cwd registry).
  const { directoryName: activeDirName } = useFileSystemContext();
  useEffect(() => {
    if (!activeDirName) { setCwdLabel(""); return; }
    const bridge = typeof window !== "undefined" ? window.orplexDesktop : undefined;
    if (bridge?.getPathForDirectory) {
      void bridge.getPathForDirectory(activeDirName)
        .then((p) => { if (p) setCwdLabel(p); })
        .catch(() => setCwdLabel(activeDirName));
    } else {
      setCwdLabel(activeDirName);
    }
  }, [activeDirName]);

  // Auto-scroll to bottom on new lines — only while pinned (scroll-lock).
  useEffect(() => {
    if (outputRef.current && atBottomRef.current) {
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
  const { directoryName: execDirName } = useFileSystemContext();

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
        dirName: execDirName ?? undefined,
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
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      // Ctrl+C cancels the running command (spec §5.6). Echo ^C like a real
      // shell, so the cancellation is visible rather than silent.
      e.preventDefault();
      if (abortRef.current) {
        abortRef.current.abort();
        pushLine({ type: "error", text: "^C", ts: Date.now() });
      }
      setRunning(false);
    } else if (e.key === "Escape") {
      if (abortRef.current) abortRef.current.abort();
      setRunning(false);
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      clearTerminal();
    }
  };

  const onScroll = () => {
    const el = outputRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div className="rp-v2-term-wrap">
      <div className="rp-v2-term-head">
        <span className="rp-v2-term-title">Terminal</span>
        <div className="rp-v2-term-actions">
          {running && <span className="rp-v2-term-badge">running</span>}
          <button className="rp-v2-term-clear" onClick={clearTerminal} title="Clear (Ctrl+L)">clear</button>
        </div>
      </div>
      {servers.length > 0 && (
        <div className="rp-v2-term-servers">
          {servers.map(s => (
            <span key={s.id} className="rp-v2-term-server" title={s.command}>
              <span className="rp-v2-term-server-dot" />{s.url ? s.url.replace("http://", ":") : `#${s.id} ${s.command.slice(0, 24)}`}
              <button
                className="rp-v2-term-server-stop"
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
        <div className="rp-v2-term-confirm" role="alert">
          <div className="rp-v2-term-confirm-text">Blocked: {pendingConfirm.reason}. Run anyway?</div>
          <div className="rp-v2-term-confirm-actions">
            <button className="rp-v2-term-confirm-run" onClick={() => void runCmd(true)}>Run anyway</button>
            <button className="rp-v2-term-confirm-cancel" onClick={() => setPendingConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}
      <div
        className="rp-v2-term rp-v2-scroll"
        ref={outputRef}
        onScroll={onScroll}
        onClick={() => inputRef.current?.focus()}
      >
        {lines.map((line, i) => (
          <div key={i} className={`rp-v2-tm-o ${line.type === "error" ? "e" : ""}`}>
            {line.type === "cmd" && <span className="rp-v2-tm-pr">$&nbsp;</span>}
            {stripAnsi(line.text)}
          </div>
        ))}
        {running && <div className="rp-v2-tm-cursor" />}
      </div>
      <div className="rp-v2-tm-pr">
        <span className="rp-v2-tm-prompt" title="Workspace working directory">{cwdLabel ? `${cwdLabel}$ ` : "$ "}</span>
        <input
          ref={inputRef}
          className="rp-v2-tm-input"
          value={cmd}
          onChange={e => setCmd(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={running ? "running…" : "Enter command…"}
          spellCheck={false}
          autoComplete="off"
          autoFocus
          aria-label="Terminal input"
        />
      </div>
    </div>
  );
}
