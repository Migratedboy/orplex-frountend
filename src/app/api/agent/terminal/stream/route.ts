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
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: string) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      };

      try {
        const { spawn } = await import("child_process");
        const cwd = process.env.WORKSPACE_DIR || process.cwd();

        const proc = spawn(command, [], {
          shell: true,
          cwd,
          timeout: 30000,
          env: { ...process.env, NODE_ENV: "development" },
        });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          stdout += text;
          send("stdout", text);
        });

        proc.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          stderr += text;
          send("stderr", text);
        });

        proc.on("close", (code) => {
          send("done", JSON.stringify({ code, stdout, stderr }));
          controller.close();
        });

        proc.on("error", (err) => {
          send("error", err.message);
          controller.close();
        });
      } catch (err: any) {
        send("error", err.message || "Failed to execute");
        controller.close();
      }
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
