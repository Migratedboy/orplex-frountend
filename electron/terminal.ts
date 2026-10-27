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
import { BrowserWindow } from "electron";
import { spawn, ChildProcess, execSync } from "node:child_process";
import { statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
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

/**
 * Shell resolution for Windows: the agent writes POSIX commands (`ls`, `wc`,
 * `cat`), which cmd.exe rejects with "'wc' is not recognized" — exit 1 on
 * perfectly safe one-liners. Git for Windows ships a real toolchain, so when
 * it is installed we spawn through its bash (`--login -c`) — the profile
 * exposes /usr/bin while the Windows cwd carries over via msys. When bash is
 * absent but a Git `usr\bin` exists, appending it to PATH lets cmd.exe still
 * resolve ls.exe/wc.exe etc. Memoized; only win32 picks a non-default shell.
 */
interface ShellPick {
  path: string;
  args: string[];
  /** POSIX-style shell — commands run bash semantics. */
  isPosix: boolean;
}

let shellCache: ShellPick | null | undefined;
let usrBinCache: string | null | undefined;

function firstFile(candidates: string[]): string | null {
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (statSync(c).isFile()) return c;
    } catch {}
  }
  return null;
}

/** Locate a Git install root from `where git`, covering custom install paths. */
function probeGitToolchain(): { bash: string | null; usrBin: string | null } {
  try {
    const out = execSync("where.exe git", {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of String(out).split(/\r?\n/)) {
      const gitExe = line.trim();
      if (!/git\.exe$/i.test(gitExe) || !existsSync(gitExe)) continue;
      // <root>\cmd\git.exe or <root>\bin\git.exe → root = two levels up.
      const root = dirname(dirname(gitExe));
      const bash = firstFile([join(root, "bin", "bash.exe"), join(root, "usr", "bin", "bash.exe")]);
      const usrBin = [join(root, "usr", "bin")].find((p) => existsSync(p)) || null;
      if (bash || usrBin) return { bash, usrBin };
    }
  } catch {}
  return { bash: null, usrBin: null };
}

function gitToolchain(): { bash: string | null; usrBin: string | null } {
  if (usrBinCache === undefined) {
    const probed = probeGitToolchain();
    shellCache = probed.bash
      ? { path: probed.bash, args: ["--login", "-c"], isPosix: true }
      : null;
    usrBinCache = probed.usrBin;
  }
  return { bash: shellCache?.path ?? null, usrBin: usrBinCache };
}

function pickShell(): ShellPick | null {
  if (process.platform !== "win32") return null;
  gitToolchain(); // ensure memoized
  return shellCache ?? null;
}

function buildSafeEnvWithToolchain(): NodeJS.ProcessEnv {
  const env = buildSafeEnv() as Record<string, string>;
  const { usrBin } = gitToolchain();
  if (usrBin) {
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
    if (!String(env[pathKey]).toLowerCase().includes(usrBin.toLowerCase())) {
      env[pathKey] = env[pathKey] ? `${env[pathKey]};${usrBin}` : usrBin;
    }
  }
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
/**
 * Origin gate injected by main (handleAppIpc). Defence in depth: the
 * sandboxed preview/agent views have ipcRenderer access even without the
 * preload bridge, so spawn-with-shell:true must be gated at the handler too,
 * not only by who can see the bridge.
 */
export type IpcGate = (channel: string, handler: (event: any, ...args: any[]) => any) => void;

export function registerTerminalIpc(getWindow: GetWindow, gate: IpcGate): void {
  // ── One-shot exec with live streaming ────────────────────────────────
  // Renderer passes a streamId; chunks arrive as terminal:stream events so
  // the Terminal tab paints live (same shape as the SSE lane it replaces).
  gate(
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
        const shell = pickShell();
        let child: ChildProcess;
        try {
          if (isWin && shell) {
            child = spawn(shell.path, [...shell.args, args!.command as string], {
              cwd,
              env: buildSafeEnvWithToolchain(),
              windowsHide: true,
            });
          } else {
            child = spawn(args!.command as string, {
              cwd,
              env: buildSafeEnvWithToolchain(),
              shell: isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh",
              windowsHide: true,
            });
          }
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
  gate(
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
      const shell = pickShell();
      let child: ChildProcess;
      try {
        if (isWin && shell) {
          child = spawn(shell.path, [...shell.args, command], {
            cwd,
            env: buildSafeEnvWithToolchain(),
            windowsHide: true,
          });
        } else {
          child = spawn(command, {
            cwd,
            env: buildSafeEnvWithToolchain(),
            shell: isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh",
            windowsHide: true,
          });
        }
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

  gate("terminal:serve-stop", async (_e, args: { id?: number }) => {
    const id = Number(args?.id);
    const entry = serveRegistry.get(id);
    if (!entry) return { ok: false, error: `no server with id ${args?.id}` };
    killTree(entry.child);
    serveRegistry.delete(id);
    return { ok: true, stopped: id };
  });

  gate("terminal:serve-list", async () => {
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
