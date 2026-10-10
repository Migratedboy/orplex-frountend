/**
 * electron/terminal.ts — On-device command execution for the desktop shell.
 *
 * In cloud mode the /api/* lanes run on Vercel (wrong machine, ephemeral),
 * so the desktop app executes commands LOCALLY in the main process: real
 * shell, real cwd (the user's workspace folder), real servers. The renderer
 * drives everything over IPC and mirrors every line into the Terminal tab.
 *
 * Self-contained by necessity: electron/tsconfig.json roots at electron/,
 * so shared src/lib modules cannot be imported here. The renderer pre-screens
 * every command with exec-guard; main re-enforces the critical denylist below
 * (defense in depth — never trust the renderer alone).
 */
import { ipcMain, BrowserWindow } from "electron";
import { spawn, ChildProcess, execSync } from "node:child_process";
import { statSync } from "node:fs";
import net from "node:net";

const MAX_COMMAND_CHARS = 4000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_CHUNK_CHARS = 8000;

/** Secret-ish env keys never passed to child processes. */
const BLOCKED_ENV_KEYS = [
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_SECRET",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "DOCKER_PASSWORD",
  "DATABASE_URL",
  "NEXTAUTH_SECRET",
  "JWT_SECRET",
  "PRIVATE_KEY",
  "SECRET_KEY",
  "API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "BUGSINK_DSN",
  "E2B_API_KEY",
];

/**
 * Critical command screen (compact twin of src/lib/exec-guard.ts — the
 * renderer runs the full screen first; this is the backstop). Returns a
 * refusal reason, or null when the command may run.
 */
export function screenTerminalCommand(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return "empty command";
  if (raw.length > MAX_COMMAND_CHARS) return "command too long (4000 char cap)";
  const cmd = raw.toLowerCase();
  // Destructive / exfiltration / escape patterns.
  const denied: Array<[RegExp, string]> = [
    [/rm\s+(-{1,2}(r|rf|fr)\b)/, "recursive delete"],
    [/:\(\)\s*\{/, "fork bomb"],
    [/mkfs|dd\s+.*of=\/dev\//, "disk destroyer"],
    [/>(\s*)\/dev\/sd/, "raw disk write"],
    [/shutdown|reboot|halt\b|poweroff/, "power control"],
    [/net\s+user|adduser|useradd/, "account manipulation"],
    [/reg\s+(delete|add)/, "registry edit"],
    [/takeown|icacls/, "ownership/ACL change"],
    [/bcdedit|bootrec/, "boot config change"],
    [/vssadmin/, "shadow-copy tampering"],
    [/cipher\s+\/w/, "secure wipe"],
    [/format\s+[a-z]:/, "disk format"],
    [/\b(?:rd|rmdir)\b[^&|;]*\/s/, "recursive remove"],
    [/\bdel(?:\.exe)?\b[^&|;]*\/s/, "recursive delete"],
    [/\berase\b[^&|;]*\/s/, "recursive erase"],
    [/\bdeltree\b/, "legacy recursive delete"],
    [/remove-item\b[^&|;]*-recurse/, "recursive remove-item"],
    [/curl[^|]*\|\s*(sh|bash|powershell|cmd)/, "pipe-to-shell download"],
    [/wget[^|]*\|\s*(sh|bash)/, "pipe-to-shell download"],
    [/powershell.*-enc(odedcommand)?\s/, "encoded powershell payload"],
    [/certutil.*-decode/, "certutil decode trick"],
    [/bitsadmin\s+\/transfer/, "bitsadmin download"],
    [/\$\([^)]*\)|\`[^\`]*\`/, "command substitution"],
    [/base64\s+(-d|--decode)[^|]*\|\s*(sh|bash)/, "base64 pipe-to-shell"],
    [/\|\s*nc(\s|$)/, "netcat pipe"],
    [/ncat\s+.*-e\s/, "netcat exec"],
    [/python3?\s+-c\s+.*socket/, "inline socket code"],
    [/chmod\s+(-r\s+)?777/, "world-writable chmod"],
    [/chown\s+.*-r/, "recursive chown"],
  ];
  for (const [re, why] of denied) {
    if (re.test(cmd)) return `blocked: ${why}`;
  }
  return null;
}

/** Absolute-path directory check — refuses anything that is not a real dir. */
export function resolveTerminalCwd(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const abs = raw.trim();
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(abs)) return null; // absolute only
  if (abs.length > 500) return null;
  try {
    if (!statSync(abs).isDirectory()) return null;
  } catch {
    return null;
  }
  return abs;
}

function buildSafeEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (BLOCKED_ENV_KEYS.some((b) => k.toUpperCase().includes(b))) continue;
    env[k] = v;
  }
  delete env.NODE_ENV;
  return env as NodeJS.ProcessEnv;
}

/** Whole-tree kill (Windows orphans grandchildren otherwise). */
function killTree(child: ChildProcess): void {
  try {
    if (child.pid === undefined) return;
    if (process.platform === "win32") {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  } catch {}
}

function isPortOpen(port: number, timeout = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Best-effort port guess: -l/-p/--port N, :PORT, or 0 when unknowable. */
export function parseServePort(command: string): number {
  const m =
    command.match(/(?:-l|-p|--port)\s+(\d{2,5})/) ||
    command.match(/:(\d{2,5})(?:\s|$)/);
  const port = m ? parseInt(m[1], 10) : 0;
  return port >= 1 && port <= 65535 ? port : 0;
}

interface ServeEntry {
  id: number;
  child: ChildProcess;
  command: string;
  cwd: string;
  port: number;
  startedAt: number;
  tail: string[];
}

const serveRegistry = new Map<number, ServeEntry>();
let serveNextId = 1;
const execChildren = new Set<ChildProcess>();

/** Kill every tracked child (quit path) — never leave zombies behind. */
export function killAllTerminalChildren(): void {
  for (const child of execChildren) killTree(child);
  execChildren.clear();
  for (const entry of serveRegistry.values()) killTree(entry.child);
  serveRegistry.clear();
}

type GetWindow = () => BrowserWindow | null;

export function registerTerminalIpc(getWindow: GetWindow): void {
  // ── One-shot exec with live streaming ────────────────────────────────
  // Renderer passes a streamId; chunks arrive as terminal:stream events so
  // the Terminal tab paints live (same shape as the SSE lane it replaces).
  ipcMain.handle(
    "terminal:exec",
    async (
      _e,
      args: { command?: string; cwd?: string; timeoutMs?: number; streamId?: string }
    ) => {
      const refusal = screenTerminalCommand(args?.command);
      if (refusal) return { ok: false, error: refusal };
      const cwd = resolveTerminalCwd(args?.cwd);
      // Be precise: a folder may well be open and this still fails when the
      // renderer could not resolve its ABSOLUTE path (the File System Access
      // API exposes no paths). Saying "open a folder first" sent users hunting
      // for a folder that was already open.
      if (!cwd) {
        return {
          ok: false,
          error: args?.cwd
            ? `the workspace path "${String(args.cwd)}" is not a reachable directory — the folder may have moved, been renamed, or be on a disconnected drive. Re-open the folder from the sidebar.`
            : "no workspace folder path is registered — open a folder (sidebar → Open, or Ctrl+O) and retry.",
        };
      }
      const timeoutMs = Math.min(
        Math.max(Number(args?.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000),
        MAX_TIMEOUT_MS
      );
      const streamId = typeof args?.streamId === "string" ? args.streamId : "";
      const win = getWindow();
      const send = (type: string, text: string) => {
        if (win && streamId) {
          win.webContents.send("terminal:stream", { streamId, type, text });
        }
      };

      return new Promise((resolve) => {
        const isWin = process.platform === "win32";
        let child: ChildProcess;
        try {
          child = spawn(args!.command as string, {
            cwd,
            env: buildSafeEnv(),
            shell: isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh",
            windowsHide: true,
          });
        } catch (err) {
          resolve({ ok: false, error: String((err as Error)?.message || err) });
          return;
        }
        execChildren.add(child);
        let stdout = "";
        let stderr = "";
        const push = (which: "stdout" | "stderr", chunk: Buffer) => {
          const text = chunk.toString().slice(0, MAX_CHUNK_CHARS);
          if (which === "stdout") stdout += text;
          else stderr += text;
          send(which, text);
        };
        child.stdout?.on("data", (d: Buffer) => push("stdout", d));
        child.stderr?.on("data", (d: Buffer) => push("stderr", d));
        const timer = setTimeout(() => {
          killTree(child);
          send("error", `timed out after ${Math.round(timeoutMs / 1000)}s (process tree killed)`);
          finish(124, true);
        }, timeoutMs);
        let finished = false;
        const finish = (code: number | null, timedOut = false) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          execChildren.delete(child);
          send("done", String(code ?? 1));
          resolve({
            ok: !timedOut && code === 0,
            stdout,
            stderr,
            exitCode: code ?? 1,
            cwd,
            timedOut,
          });
        };
        child.on("error", (err) => {
          send("error", String(err?.message || err));
          finish(1);
        });
        child.on("close", (code) => finish(code ?? 1));
      });
    }
  );

  // ── Detached serve lane ──────────────────────────────────────────────
  ipcMain.handle(
    "terminal:serve-start",
    async (_e, args: { command?: string; cwd?: string }) => {
      const refusal = screenTerminalCommand(args?.command);
      if (refusal) return { ok: false, error: refusal };
      const cwd = resolveTerminalCwd(args?.cwd);
      if (!cwd) {
        return {
          ok: false,
          error: args?.cwd
            ? `the workspace path "${String(args.cwd)}" is not a reachable directory — the folder may have moved, been renamed, or be on a disconnected drive. Re-open the folder from the sidebar.`
            : "no workspace folder path is registered — open a folder (sidebar → Open, or Ctrl+O) and retry.",
        };
      }
      const command = (args!.command as string).trim();
      const port = parseServePort(command);
      const isWin = process.platform === "win32";
      let child: ChildProcess;
      try {
        child = spawn(command, {
          cwd,
          env: buildSafeEnv(),
          shell: isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh",
          windowsHide: true,
        });
      } catch (err) {
        return { ok: false, error: String((err as Error)?.message || err) };
      }
      const id = serveNextId++;
      const entry: ServeEntry = {
        id,
        child,
        command: command.slice(0, 200),
        cwd,
        port,
        startedAt: Date.now(),
        tail: [],
      };
      serveRegistry.set(id, entry);
      const tail = (line: string) => {
        entry.tail.push(line.slice(0, 500));
        if (entry.tail.length > 40) entry.tail.splice(0, entry.tail.length - 40);
      };
      child.stdout?.on("data", (d: Buffer) => tail(d.toString()));
      child.stderr?.on("data", (d: Buffer) => tail(d.toString()));
      child.on("error", () => serveRegistry.delete(id));
      child.on("close", () => serveRegistry.delete(id));

      // Wait for the port (when known) so the caller gets a real verdict
      // instead of "started (maybe)". No port in the command → trust + tail.
      if (port > 0) {
        const deadline = Date.now() + 25_000;
        let up = false;
        while (Date.now() < deadline) {
          if (child.exitCode !== null && child.exitCode !== undefined) break;
          if (await isPortOpen(port)) {
            up = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        if (!up) {
          const earlyTail = entry.tail.slice(-10).join("\n");
          killTree(child);
          serveRegistry.delete(id);
          return { ok: false, error: `server never opened port ${port}`, tail: earlyTail };
        }
        return { ok: true, id, port, url: `http://localhost:${port}`, tail: entry.tail.slice(-10).join("\n") };
      }
      await new Promise((r) => setTimeout(r, 1500));
      if (child.exitCode !== null && child.exitCode !== undefined && child.exitCode !== 0) {
        const earlyTail = entry.tail.slice(-10).join("\n");
        serveRegistry.delete(id);
        return { ok: false, error: `server exited immediately (code ${child.exitCode})`, tail: earlyTail };
      }
      return { ok: true, id, port: 0, tail: entry.tail.slice(-10).join("\n") };
    }
  );

  ipcMain.handle("terminal:serve-stop", async (_e, args: { id?: number }) => {
    const id = Number(args?.id);
    const entry = serveRegistry.get(id);
    if (!entry) return { ok: false, error: `no server with id ${args?.id}` };
    killTree(entry.child);
    serveRegistry.delete(id);
    return { ok: true, stopped: id };
  });

  ipcMain.handle("terminal:serve-list", async () => {
    return {
      ok: true,
      servers: [...serveRegistry.values()].map((e) => ({
        id: e.id,
        command: e.command,
        cwd: e.cwd,
        port: e.port,
        url: e.port > 0 ? `http://localhost:${e.port}` : null,
        startedAt: e.startedAt,
      })),
    };
  });
}
