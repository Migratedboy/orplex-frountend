import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// Block dangerous commands
const BLOCKED = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", ":(){ :|:& };:"];

function isBlocked(cmd: string): boolean {
  const lower = cmd.toLowerCase().trim();
  return BLOCKED.some(b => lower.includes(b));
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const { command } = await request.json();
  if (!command || typeof command !== "string") {
    return new Response(JSON.stringify({ error: "No command" }), { status: 400 });
  }

  if (isBlocked(command)) {
    return new Response(JSON.stringify({ error: "Command blocked for safety" }), { status: 403 });
  }

  // SSE stream
  const encoder = new TextEncoder();
  let childProc: import("child_process").ChildProcess | null = null;

  const killChild = (force = false) => {
    if (!childProc || childProc.killed) return;
    if (childProc.exitCode !== null || childProc.signalCode !== null) return;
    try {
      childProc.kill(force ? "SIGKILL" : "SIGTERM");
      // On Windows SIGTERM is ignored — escalate after a grace period
      if (process.platform === "win32" || force) {
        setTimeout(() => {
          if (childProc && childProc.exitCode === null && childProc.signalCode === null) {
            try {
              childProc.kill("SIGKILL");
            } catch {}
          }
        }, 3000).unref?.();
      }
    } catch {}
  };

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: string) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch {
          // Stream already closed — client gone
        }
      };

      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        killChild();
        try {
          controller.close();
        } catch {}
      };

      try {
        const { spawn } = await import("child_process");
        const cwd = process.env.WORKSPACE_DIR || process.cwd();

        const proc = spawn(command, [], {
          shell: true,
          cwd,
          env: { ...process.env, NODE_ENV: "development" },
        });
        childProc = proc;

        let stdout = "";
        let stderr = "";
        let killedByTimeout = false;

        const timeoutTimer = setTimeout(() => {
          killedByTimeout = true;
          killChild(true);
          send("error", "Command timed out after 30s");
          finish();
        }, 30000);
        timeoutTimer.unref?.();

        proc.stdout?.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          stdout += text;
          send("stdout", text);
        });

        proc.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          stderr += text;
          send("stderr", text);
        });

        proc.on("close", (code) => {
          clearTimeout(timeoutTimer);
          if (!killedByTimeout) {
            send("done", JSON.stringify({ code, stdout, stderr }));
          }
          finish();
        });

        proc.on("error", (err) => {
          clearTimeout(timeoutTimer);
          send("error", err.message);
          finish();
        });
      } catch (err: any) {
        send("error", err.message || "Failed to execute");
        finish();
      }
    },
    cancel() {
      // Client disconnected (tab closed, fetch aborted) — kill the child process
      killChild(true);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
