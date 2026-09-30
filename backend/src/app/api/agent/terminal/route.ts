import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
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
    if (process.env.AGENT_EXEC_DISABLED === "1") {
      return NextResponse.json({ error: "Command execution is disabled on this deployment (AGENT_EXEC_DISABLED=1)." }, { status: 403 });
    }

    const { command } = await request.json();
    if (!command || typeof command !== "string") {
      return NextResponse.json({ error: "No command provided" }, { status: 400 });
    }

    const guard = isCommandAllowed(command);
    if (!guard.allowed) {
      return NextResponse.json({ error: `Command blocked for safety: ${guard.reason}` }, { status: 403 });
    }

    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      const upper = k.toUpperCase();
      // Same secret-strip policy as /api/agent/exec.
      if (/AWS_SECRET|AWS_SESSION|AZURE_CLIENT|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|DOCKER_PASSWORD|DATABASE_URL|NEXTAUTH_SECRET|JWT_SECRET|PRIVATE_KEY|SECRET_KEY|API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|BUGSINK_DSN|E2B_API_KEY/.test(upper)) continue;
      env[k] = v;
    }
    delete env.NODE_ENV;

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
