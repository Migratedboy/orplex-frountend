import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { checkBurstLimit } from "@/lib/rate-limiter";
import { isCommandAllowed } from "@/lib/exec-guard";
import { TIMEOUTS, LIMITS } from "@/lib/constants";
import { getWorkspaceCwdForUser } from "@/lib/workspace-cwd";

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!(await checkBurstLimit(userId).catch(() => false))) {
      return NextResponse.json({ error: "Too many requests. Try again in about a minute." }, { status: 429, headers: { "Retry-After": "60" } });
    }
    if (process.env.AGENT_EXEC_DISABLED === "1") {
      return NextResponse.json({ error: "Command execution is disabled on this deployment (AGENT_EXEC_DISABLED=1)." }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    const command = typeof body?.command === "string" ? body.command : "";
    if (!command) {
      return NextResponse.json({ error: "No command provided" }, { status: 400 });
    }
    if (command.length > 4000) {
      return NextResponse.json({ error: "Command too long" }, { status: 400 });
    }

    const guard = isCommandAllowed(command);
    if (!guard.allowed) {
      return NextResponse.json({ error: `Command blocked for safety: ${guard.reason}` }, { status: 403 });
    }

    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    // Shared secret-strip policy (exec-guard) — never hand-rolled per route.
    // (It already drops NODE_ENV; do not delete again here.)
    const { buildSafeEnv } = await import("@/lib/exec-guard");
    const env = buildSafeEnv();

    const { stdout, stderr } = await execAsync(command, {
      timeout: TIMEOUTS.SANDBOX_EXEC,
      maxBuffer: LIMITS.EXEC_BUFFER,
      cwd: getWorkspaceCwdForUser(userId) || process.env.WORKSPACE_DIR || process.cwd(),
      env: env as NodeJS.ProcessEnv,
    });

    const output = (stdout || "") + (stderr ? `\nSTDERR: ${stderr}` : "");
    const truncated = output.length > LIMITS.OUTPUT_TRUNCATE * 2 ? output.slice(0, LIMITS.OUTPUT_TRUNCATE * 2) + "\n... [truncated]" : output;

    return NextResponse.json({ output: truncated || "(no output)" });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return NextResponse.json({ output: "Command aborted", error: true });
    }
    const output = (err.stdout || "") + (err.stderr ? `\nSTDERR: ${err.stderr}` : "");
    return NextResponse.json({
      output: output || err.message || "Command failed",
      error: true,
    });
  }
}
