// API route for LONG-RUNNING command execution (dev/preview servers).
//
// Why this exists: `run_command` uses child_process.exec and WAITS for exit.
// A server never exits — so serving "npx serve . -l 3001" through it burns
// the whole 30-60s timeout, gets killed, and on Windows the kill often
// orphans the grandchild node process, which keeps holding the port. The
// next serve attempt then dies instantly with EADDRINUSE (\"exit 1\") — the
// exact failure users saw.
//
// This lane instead: detaches the server process (survives the request),
// streams its early output to a buffer, WAITS for the port to accept
// connections, and returns success/failure quickly. A /stop action kills the
// whole process tree (taskkill /T on Windows) so nothing orphans.
//
// SECURITY: servers run in the CALLER's registered workspace and are tracked
// per user — stop/start never touches another user's processes. The same
// exec-guard screening as /api/agent/exec applies.

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { isCommandAllowed } from "@/lib/exec-guard";
import { getWorkspaceCwdForUser } from "@/lib/workspace-cwd";
import { spawn, type SpawnOptions } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface ServeEntry {
  pid: number;
  command: string;
  cwd: string;
  port: number;
  logFile: string;
  startedAt: number;
  tail: string[];
  userId: string;
}

// In-memory registry (per dev-server process). Enough for preview servers —
// a server restart clears it, and stale PIDs are handled on stop/kill.
const serves = new Map<string, ServeEntry>();

const MAX_TAIL_LINES = 40;

function detectPort(command: string): number | null {
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

async function waitUntilListening(port: number, timeoutMs: number): Promise<boolean> {
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

function treeKill(pid: number): Promise<void> {
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

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    const userId = session?.user?.id;
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (process.env.AGENT_EXEC_DISABLED === "1") {
      return Response.json(
        { error: "Command execution is disabled on this deployment (AGENT_EXEC_DISABLED=1).", disabled: true },
        { status: 403 }
      );
    }

    const body = await request.json();
    const action = body.action === "stop" ? "stop" : "start";

    if (action === "stop") {
      const id = typeof body.id === "string" ? body.id : null;
      let stopped = 0;
      // Only ever touch THIS user's serves.
      const owned = (key: string) => serves.get(key)?.userId === userId;
      if (id && serves.has(id) && owned(id)) {
        const entry = serves.get(id)!;
        await treeKill(entry.pid);
        serves.delete(id);
        stopped = 1;
      } else if (!id) {
        // stop all of this user's tracked serves (workspace reset / new task)
        for (const [key, entry] of Array.from(serves.entries())) {
          if (!owned(key)) continue;
          await treeKill(entry.pid);
          serves.delete(key);
          stopped++;
        }
      }
      return Response.json({ ok: true, stopped });
    }

    const command = typeof body.command === "string" ? body.command : "";
    if (!command) return Response.json({ error: "No command provided" }, { status: 400 });

    const guard = isCommandAllowed(command);
    if (!guard.allowed) {
      return Response.json({
        ok: false,
        error: `BLOCKED: ${guard.reason}`,
        exitCode: 126,
      });
    }

    const cwd = getWorkspaceCwdForUser(userId) || process.cwd();
    const port = detectPort(command);

    // Port pre-flight: if something already listens there, fail fast with a
    // precise message (the model can pick another port) instead of a confusing
    // EADDRINUSE crash after spawn.
    if (port !== null && (await waitUntilListening(port, 300))) {
      return Response.json({
        ok: false,
        error: `Port ${port} is already in use by another process. Either stop the old server first or serve on a different port (e.g. -l ${port + 1}).`,
        exitCode: 98,
        portBusy: port,
      });
    }

    const id = `serve-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const logFile = join(tmpdir(), `orplex-serve-${id}.log`);
    try { await mkdir(tmpdir(), { recursive: true }); await appendFile(logFile, ""); } catch {}

    const isWin = process.platform === "win32";
    // Same secret-strip policy as /api/agent/exec (keeps its list in sync).
    const serveEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      const upper = k.toUpperCase();
      if (/AWS_SECRET|AWS_SESSION|AZURE_CLIENT|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|DOCKER_PASSWORD|DATABASE_URL|NEXTAUTH_SECRET|JWT_SECRET|PRIVATE_KEY|SECRET_KEY|API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|BUGSINK_DSN|E2B_API_KEY/.test(upper)) continue;
      serveEnv[k] = v;
    }
    delete serveEnv.NODE_ENV; // don't pin a mode on the user's project

    const spawnOptions: SpawnOptions = {
      cwd,
      shell: isWin ? (process.env.ComSpec || "cmd.exe") : "/bin/sh",
      detached: !isWin, // own process group on POSIX for group-kill; Windows uses taskkill /T
      stdio: ["ignore", "pipe", "pipe"],
      env: serveEnv as NodeJS.ProcessEnv,
    };
    const child = spawn(command, spawnOptions);

    const entry: ServeEntry = {
      pid: child.pid ?? 0,
      command,
      cwd,
      port: port ?? 0,
      logFile,
      startedAt: Date.now(),
      tail: [],
      userId,
    };
    serves.set(id, entry);

    const tail = (chunk: Buffer | string) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        entry.tail.push(line);
        if (entry.tail.length > MAX_TAIL_LINES) entry.tail.shift();
      }
      appendFile(logFile, text).catch(() => {});
    };
    child.stdout?.on("data", tail);
    child.stderr?.on("data", tail);

    // Early-exit detection: if the process dies within the wait window, report
    // its output (real error) instead of pretending the server is up.
    const exitedEarly = await new Promise<{ code: number | null } | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 12_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve({ code });
      });
    });

    let listening = false;
    if (port !== null) {
      listening = await waitUntilListening(port, exitedEarly ? 0 : 20_000);
    } else {
      // No port detected — consider it up if it survived the early-exit window
      listening = exitedEarly === null;
    }

    if (exitedEarly !== null) {
      serves.delete(id);
      return Response.json({
        ok: false,
        error: `Server exited immediately (code ${exitedEarly.code ?? "?"}). Output:\n${entry.tail.join("\n").slice(0, 2000)}`,
        exitCode: exitedEarly.code ?? 1,
      });
    }

    if (port !== null && !listening) {
      // Still running but never bound — report early output for diagnosis
      return Response.json({
        ok: false,
        error: `Server is running but never opened port ${port}. Early output:\n${entry.tail.join("\n").slice(0, 2000)}`,
        exitCode: 1,
      });
    }

    return Response.json({
      ok: true,
      id,
      pid: entry.pid,
      port,
      cwd,
      output: entry.tail.slice(-8).join("\n"),
      message: port
        ? `Server is running at http://localhost:${port} (log: ${logFile})`
        : `Server is running (log: ${logFile})`,
    });
  } catch (error) {
    return Response.json(
      { error: (error as Error).message || "Internal error" },
      { status: 500 }
    );
  }
}

export async function GET() {
  const session = await getServerSession(jwtOnlyOptions);
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({
    serves: Array.from(serves.entries())
      .filter(([, e]) => e.userId === userId)
      .map(([id, e]) => ({
        id,
        pid: e.pid,
        port: e.port,
        command: e.command,
        cwd: e.cwd,
        startedAt: e.startedAt,
        tail: e.tail.slice(-10),
      })),
  });
}
