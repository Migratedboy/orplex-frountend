// terminal-lane.ts — One execution path for user-typed AND agent-run commands.
//
// Lane selection (shared by the Terminal tab and the agent's run_command):
//   1. Electron desktop bridge (window.orplexDesktop.terminal) → runs ON THE
//      USER'S DEVICE in their workspace folder. Preferred whenever present.
//   2. API lane (/api/agent/terminal/session, SSE) → self-hosted servers (also
//      the user's device) or the cloud backend when split. Unchanged behavior.
//
// Renderer-side only in practice (window/localStorage), but every function
// degrades to null/false outside a browser so imports never crash tests.
//
// Output discipline: per-chunk and per-line caps keep a build log from
// flooding the tab transcript or the model's context window.

import { isCommandAllowed } from "./exec-guard";
import { emitTerminalLine, type TerminalLineSource } from "./terminal-events";
import { listProjects } from "./project-registry";
import { apiFetch } from "@/lib/api-base";

export const TERMINAL_MAX_LINE_CHARS = 4000;
export const TERMINAL_MAX_BUFFER_LINES = 200;
export const TERMINAL_DEFAULT_TIMEOUT_MS = 60_000;

export function hasDesktopTerminal(): boolean {
  try {
    return typeof window !== "undefined" && !!window.orplexDesktop?.terminal;
  } catch {
    return false;
  }
}

/**
 * Absolute workspace cwd for on-device execution (Electron only). Resolved
 * from the project roster the folder picker maintains — the same source the
 * server registry uses, so device and server runs agree on cwd.
 */
export function resolveDesktopCwd(dirName?: string | null): string | null {
  try {
    if (typeof window === "undefined" || !dirName) return null;
    const entry = listProjects(window.localStorage).find((p) => p.name === dirName);
    const cand = entry?.lastPath;
    if (typeof cand === "string" && /^(?:[A-Za-z]:[\\/]|\/)/.test(cand)) return cand;
    return null;
  } catch {
    return null;
  }
}

/**
 * Manual-input screen (warn+confirm policy): dangerous commands are NOT
 * auto-run from the Terminal tab — the caller shows the reason inline and
 * runs only on explicit confirm. Agent calls never reach here (native-tools
 * screens + risk-gates them first).
 */
export function screenManualCommand(
  command: string
): { ok: true } | { ok: false; reason: string } {
  const verdict = isCommandAllowed(command);
  if (verdict.allowed) return { ok: true };
  return { ok: false, reason: verdict.reason };
}

export interface TerminalRunOptions {
  command: string;
  /** Absolute workspace dir (desktop lane) — resolved per call when omitted. */
  cwd?: string | null;
  /** Folder NAME to resolve the cwd from (project roster). */
  dirName?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal | null;
  /** Who ran it — paints the [agent]/[you] tag in the tab. */
  source: TerminalLineSource;
  /** Live chunks (already capped) for custom consumers. */
  onChunk?: (type: "stdout" | "stderr", text: string) => void;
  /** Skip the terminal bus (caller paints itself). Default: emit. */
  quiet?: boolean;
}

export interface TerminalRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd?: string;
  lane: "desktop" | "api";
  timedOut?: boolean;
  error?: string;
}

function capLine(text: string): string {
  return text.length > TERMINAL_MAX_LINE_CHARS
    ? text.slice(0, TERMINAL_MAX_LINE_CHARS) + "\n…[line truncated]"
    : text;
}

/**
 * Run one command through the best available lane and mirror every line to
 * the terminal bus (unless quiet). Returns the collected result for the
 * model transcript / tab status.
 */
export async function runTerminalCommand(opts: TerminalRunOptions): Promise<TerminalRunResult> {
  const { command, timeoutMs, signal, source, onChunk, quiet } = opts;
  const emit = (type: "cmd" | "stdout" | "stderr" | "done" | "error", text: string) => {
    if (!quiet) emitTerminalLine(type, text, source);
    if (onChunk && (type === "stdout" || type === "stderr")) onChunk(type, capLine(text));
  };

  emit("cmd", `$ ${command}`);
  const bridge = hasDesktopTerminal()
    ? window.orplexDesktop!.terminal!
    : null;
  const cwd = opts.cwd ?? resolveDesktopCwd(opts.dirName ?? null) ?? undefined;

  // ── Desktop lane: main-process shell on the user's device ────────────
  if (bridge) {
    const streamId = `t-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    let stdout = "";
    let stderr = "";
    const off = bridge.onStream((ev) => {
      if (ev.streamId !== streamId) return;
      if (ev.type === "stdout" || ev.type === "stderr") {
        const capped = capLine(ev.text);
        if (ev.type === "stdout") stdout += capped;
        else stderr += capped;
        emit(ev.type, capped);
      }
    });
    // Abort (Esc/Stop) — the main process kills the tree; the rejection
    // below converts to a clean aborted result.
    const onAbort = () => off();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const r = await bridge.exec({
        command,
        cwd,
        timeoutMs: Math.min(timeoutMs ?? TERMINAL_DEFAULT_TIMEOUT_MS, 300_000),
        streamId,
      });
      stdout = typeof r.stdout === "string" ? r.stdout : stdout;
      stderr = typeof r.stderr === "string" ? r.stderr : stderr;
      const exitCode = typeof r.exitCode === "number" ? r.exitCode : 1;
      if (!r.ok && r.error && !stdout && !stderr) emit("error", r.error);
      else if (exitCode !== 0) emit("error", `exit code ${exitCode}`);
      else emit("done", "");
      return {
        stdout,
        stderr,
        exitCode: r.ok ? exitCode : (typeof r.exitCode === "number" ? r.exitCode : 1),
        cwd: r.cwd,
        lane: "desktop",
        timedOut: r.timedOut,
        error: r.ok ? undefined : r.error,
      };
    } catch (err) {
      const msg = String((err as Error)?.message || err);
      emit("error", signal?.aborted ? "aborted" : msg);
      return { stdout, stderr, exitCode: signal?.aborted ? 130 : 1, lane: "desktop", error: msg };
    } finally {
      off();
      signal?.removeEventListener?.("abort", onAbort);
    }
  }

  // ── API lane: persistent shell session (SSE), unchanged behavior ──────
  try {
    const res = await apiFetch("/api/agent/terminal/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command }),
      signal: signal ?? undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({} as any));
      const msg = (err as any).error || `HTTP ${res.status}`;
      emit("error", msg);
      return { stdout: "", stderr: msg, exitCode: 1, lane: "api", error: msg };
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const event of events) {
        let eventType = "";
        let eventData = "";
        for (const line of event.split("\n")) {
          if (line.startsWith("event: ")) eventType = line.slice(7);
          if (line.startsWith("data: ")) eventData = line.slice(6);
        }
        try {
          eventData = JSON.parse(eventData);
        } catch {}
        if ((eventType === "stdout" || eventType === "stderr") && eventData) {
          const capped = capLine(String(eventData));
          if (eventType === "stdout") stdout += capped;
          else stderr += capped;
          emit(eventType, capped);
        } else if (eventType === "done") {
          const code = parseInt(String(eventData), 10);
          exitCode = Number.isNaN(code) ? 0 : code;
          if (exitCode !== 0) emit("error", `exit code ${exitCode}`);
          else emit("done", "");
        } else if (eventType === "error" && eventData) {
          stderr += capLine(String(eventData));
          emit("error", capLine(String(eventData)));
          exitCode = 1;
        }
      }
    }
    return { stdout, stderr, exitCode, lane: "api" };
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    emit("error", signal?.aborted ? "aborted" : msg);
    return { stdout: "", stderr: msg, exitCode: signal?.aborted ? 130 : 1, lane: "api", error: msg };
  }
}
