/**
 * serve-process.ts — pure process helpers of the detached serve lane
 * (/api/agent/serve). Extracted from the route so they are unit-testable and
 * reusable without touching the HTTP layer. The serve registry and the
 * auth/ownership rules stay in the route.
 *
 * treeKill is the ONE process-group killer for serve children — the sibling
 * copies in electron/ (next-children, terminal) serve the DESKTOP app and
 * must not import Next/server code, so the boundary stays intact.
 *
 * Spawn orchestration (cwd/shell/env tuning per attempt) stays in the route —
 * that is HTTP-lane business logic.
 */

/** Detect the port a serve command will listen on; null when none declared. */
export function detectPort(command: string): number | null {
  // -l 3001 | --listen 3001 | -p 3001 | --port 3001 | http.server 3001 | :3001
  const patterns = [
    /(?:-l|--listen|-p|--port)\s+(\d{2,5})/,
    /http\.server\s+(\d{2,5})/,
    /:\s?(\d{4,5})\b/,
  ];
  for (const re of patterns) {
    const m = command.match(re);
    if (m) {
      const port = parseInt(m[1], 10);
      if (port >= 1 && port <= 65535) return port;
    }
  }
  return null;
}

/** Poll 127.0.0.1:<port> until a TCP connection succeeds or the deadline hits. */
export async function waitUntilListening(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const net = require("node:net") as typeof import("node:net");
      const socket = new net.Socket();
      const done = (result: boolean) => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(800);
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
      socket.connect(port, "127.0.0.1");
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Kill a detached serve process tree (Windows: taskkill /T; POSIX: group kill). */
export function treeKill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      // /T = tree (children too) — prevents orphaned node servers holding ports
      const { execFile } = require("node:child_process") as typeof import("node:child_process");
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve());
    } else {
      try {
        process.kill(-pid, "SIGKILL"); // negative pid = process group
      } catch {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      resolve();
    }
  });
}

/** Spawn options the serve lane uses: the route builds its own (cwd, shell, env). */
