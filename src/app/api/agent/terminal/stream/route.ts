import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { isCommandAllowed, buildSafeEnv } from "@/lib/exec-guard";
import { getWorkspaceCwdForUser } from "@/lib/workspace-cwd";

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const command = typeof body?.command === "string" ? body.command : "";
  if (!command) {
    return new Response(JSON.stringify({ error: "No command" }), { status: 400 });
  }
  if (command.length > 4000) {
    return new Response(JSON.stringify({ error: "Command too long" }), { status: 400 });
  }

  // Same screening as the exec route: the old substring denylist was
  // bypassable (powershell -enc, curl|sh, del, env-prefix tricks).
  const guard = isCommandAllowed(command);
  if (!guard.allowed) {
    return new Response(JSON.stringify({ error: `Command blocked for safety: ${guard.reason}` }), { status: 403 });
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
        // THIS user's registered workspace — never the server dir and never
        // another user's checkout. Secrets stay out of the child env.
        const workspace = getWorkspaceCwdForUser(userId);
        const cwd = workspace || process.cwd();

        const proc = spawn(command, [], {
          shell: true,
          cwd,
          env: buildSafeEnv() as NodeJS.ProcessEnv,
        });
        childProc = proc;

        // Accumulated output is capped: a 30s verbose command could
        // otherwise buffer gigabytes for the final `done` payload. Live
        // chunks still stream uncapped; only the retained summary is cut.
        const MAX_RETAINED = 512 * 1024;
        let stdout = "";
        let stderr = "";
        let truncated = false;
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
          if (stdout.length < MAX_RETAINED) {
            stdout += text.slice(0, MAX_RETAINED - stdout.length);
            if (stdout.length >= MAX_RETAINED) truncated = true;
          }
          send("stdout", text);
        });

        proc.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          if (stderr.length < MAX_RETAINED) {
            stderr += text.slice(0, MAX_RETAINED - stderr.length);
            if (stderr.length >= MAX_RETAINED) truncated = true;
          }
          send("stderr", text);
        });

        proc.on("close", (code) => {
          clearTimeout(timeoutTimer);
          if (!killedByTimeout) {
            send("done", JSON.stringify({ code, stdout, stderr, truncated }));
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
