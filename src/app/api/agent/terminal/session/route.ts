// SSE route for the PERSISTENT real shell session.
// Every request runs the command inside the shared shell (cd/env persist,
// servers keep running in the background) and streams its output live.

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { runInShell, onShellOutput, killShell } from "@/lib/shell-session";
import { isCommandAllowed } from "@/lib/exec-guard";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const session = await getServerSession(jwtOnlyOptions);
  const userId = session?.user?.id;
  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }
  if (process.env.AGENT_EXEC_DISABLED === "1") {
    return new Response(JSON.stringify({ error: "Command execution is disabled on this deployment (AGENT_EXEC_DISABLED=1)." }), { status: 403, headers: { "Content-Type": "application/json" } });
  }

  const { command, action } = await request.json().catch(() => ({}));

  // Control actions (no SSE): kill the session shell
  if (action === "kill") {
    killShell(userId);
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  }

  if (!command || typeof command !== "string") {
    return new Response(JSON.stringify({ error: "No command" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const guard = isCommandAllowed(command);
  if (!guard.allowed) {
    return new Response(JSON.stringify({ error: `Command blocked for safety: ${guard.reason}` }), { status: 403, headers: { "Content-Type": "application/json" } });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        try { controller.close(); } catch {}
      };
      const send = (event: string, data: string) => {
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch {}
      };

      // Forward ALL live shell output of THIS user's shell until this command
      // completes.
      const unsub = onShellOutput(userId, (event, data) => send(event === "exit" ? "done" : event, data));

      try {
        const { code, timedOut } = await runInShell(userId, command);
        if (timedOut) send("error", "Command still running — output keeps streaming; use Stop to kill the session shell.");
        if (code !== null && code !== 0) send("error", `exit code ${code}`);
      } catch (err: any) {
        send("error", err?.message || "Failed to execute");
      } finally {
        unsub();
        // Small delay so trailing output flushes to the client before close.
        setTimeout(finish, 150);
      }
    },
    // Client disconnected — the COMMAND keeps running in the real shell
    // (like a real terminal), the stream just detaches.
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
