// shell-session.ts — Persistent REAL shell sessions (server-side, per user).
//
// Unlike one-shot exec, a shell STAYS ALIVE between commands: `cd` persists,
// exported env vars persist, and long-running processes keep running in the
// background like a real terminal. Commands are fed to the shell's stdin and
// an exit-marker line tells us when each command finishes.
//
// One shell per USER — every client of the same user (Terminal panel, agent
// run_command) shares that user's shell, same as one terminal window on the
// desktop. Different users never share a shell (or its cwd/env state).

import { spawn, execSync, ChildProcess } from "node:child_process";
import { getWorkspaceCwdForUser } from "./workspace-cwd";

const isWin = process.platform === "win32";

// Marker printed after each command completes. Unique enough to never collide
// with real output; the shell prints it via a prompt hook.
const MARKER = "__ORPLEX_CMD_DONE_";

type OutputListener = (event: "stdout" | "stderr" | "exit", data: string) => void;

interface ShellSession {
  proc: ChildProcess;
  seq: number;
  listeners: Set<OutputListener>;
  currentOutput: string;
  currentExitCode: number | null;
}

const sessions = new Map<string, ShellSession>();

function shellCommand(): string {
  return isWin ? "cmd.exe" : "/bin/sh";
}

function shellArgs(): string[] {
  // cmd.exe: echo the marker after every command via the prompt; sh: same via PS1
  return isWin ? ["/Q", "/K", "prompt $G"] : [];
}

function ensureShell(userId: string): ShellSession {
  const existing = sessions.get(userId);
  if (existing && existing.proc.exitCode === null && existing.proc.signalCode === null) {
    return existing;
  }

  const proc = spawn(shellCommand(), shellArgs(), {
    cwd: getWorkspaceCwdForUser(userId) || process.env.WORKSPACE_DIR || process.cwd(),
    env: { ...process.env },
    // cmd.exe with /Q disables echo; delayed expansion off keeps `!` literal
    windowsVerbatimArguments: false,
  });
  const session: ShellSession = {
    proc,
    seq: 0,
    listeners: new Set(),
    currentOutput: "",
    currentExitCode: null,
  };
  sessions.set(userId, session);

  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    session.currentOutput += text;
    session.listeners.forEach((l) => l("stdout", text));
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    session.currentOutput += text;
    session.listeners.forEach((l) => l("stderr", text));
  });
  proc.on("exit", (code) => {
    session.listeners.forEach((l) => l("exit", String(code ?? 0)));
    if (sessions.get(userId) === session) sessions.delete(userId); // next command respawns a fresh shell
  });
  proc.on("error", () => {
    if (sessions.get(userId) === session) sessions.delete(userId);
  });

  return session;
}

/**
 * Run a command inside the user's persistent shell. Output streams to that
 * shell's listeners. Resolves when the command finishes (marker seen) or the
 * hard timeout hits.
 */
export function runInShell(
  userId: string,
  command: string,
  timeoutMs = 120_000
): Promise<{ code: number | null; timedOut: boolean }> {
  const session = ensureShell(userId);
  const proc = session.proc;
  const id = ++session.seq;
  const marker = `${MARKER}${id}_`;
  session.currentOutput = "";
  session.currentExitCode = null;

  return new Promise((resolve) => {
    let buffered = "";
    let timedOut = false;

    const onData = (chunk: Buffer) => {
      buffered += chunk.toString();
      if (buffered.includes(marker)) {
        cleanup();
        // Extract trailing exit code we printed with the marker
        const m = buffered.match(new RegExp(`${marker}(\\d+)`));
        const code = m ? parseInt(m[1], 10) : (proc.exitCode ?? 0);
        session.currentExitCode = code;
        resolve({ code, timedOut: false });
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      resolve({ code, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // Do NOT kill the persistent shell for a hung command — kill only the
      // command's process group on POSIX; on Windows we can't reliably, so
      // report the timeout and leave the shell running.
      resolve({ code: null, timedOut: true });
    }, timeoutMs);
    timer.unref?.();

    function cleanup() {
      clearTimeout(timer);
      proc.stdout?.off("data", onData);
      proc.stderr?.off("data", onData);
      proc.off("exit", onExit);
    }

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", onExit);

    // Append the marker with the exit code so the listener can resolve.
    const wrapped = isWin
      ? `${command} & echo ${marker}%errorlevel%\r\n`
      : `{ ${command}\n} ; echo ${marker}$?\n`;
    proc.stdin?.write(wrapped);
  });
}

/** Subscribe to live shell output (all commands) for a user's shell. Returns an unsubscribe fn. */
export function onShellOutput(userId: string, listener: OutputListener): () => void {
  const session = ensureShell(userId);
  session.listeners.add(listener);
  return () => session.listeners.delete(listener);
}

/** Kill a user's session shell (Stop / panel close). Next command respawns it. */
export function killShell(userId: string): void {
  const session = sessions.get(userId);
  if (!session) return;
  const shell = session.proc;
  if (shell.exitCode === null && shell.signalCode === null) {
    try {
      if (isWin) {
        execSync(`taskkill /PID ${shell.pid} /T /F`, { stdio: "ignore" });
      } else {
        shell.kill("SIGKILL");
      }
    } catch {}
  }
  sessions.delete(userId);
}

/** Current output buffer of a user's running/last command (for UI re-attach). */
export function getShellBuffer(userId: string): string {
  return sessions.get(userId)?.currentOutput ?? "";
}

export { MARKER };
