// API route for sandboxed command execution
// The background worker (client-side) calls this instead of importing child_process directly

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { isBlockedCommand, TIMEOUTS, LIMITS } from "@/lib/constants";

// Environment variables to strip — never pass secrets to child processes
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

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { command, timeout, maxBuffer } = await request.json();
    if (!command || typeof command !== "string") {
      return Response.json({ error: "No command provided" }, { status: 400 });
    }

    // Block known dangerous commands
    if (isBlockedCommand(command)) {
      return Response.json({
        stdout: "",
        stderr: "BLOCKED: command matches a blocked pattern",
        exitCode: 126,
      });
    }

    // Dynamic import — server-side only
    const { exec: rawExec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(rawExec);

    // Build restricted PATH
    const safePath = [
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      process.cwd() + "/node_modules/.bin",
      (process.env.HOME || "") + "/.local/bin",
    ].join(":");

    // Build restricted environment
    const safeEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      const upperKey = key.toUpperCase();
      if (BLOCKED_ENV_KEYS.some(blocked => upperKey.includes(blocked))) continue;
      safeEnv[key] = value;
    }
    safeEnv.PATH = safePath;
    safeEnv.NODE_ENV = "development";

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: timeout || TIMEOUTS.COMMAND_EXEC,
        maxBuffer: maxBuffer || LIMITS.EXEC_BUFFER,
        cwd: process.cwd(),
        env: safeEnv as NodeJS.ProcessEnv,
        shell: "/bin/sh",
      });

      // Truncate output
      let out = stdout || "";
      let err = stderr || "";
      if (out.length > LIMITS.OUTPUT_TRUNCATE) {
        out = out.slice(0, LIMITS.OUTPUT_TRUNCATE) + "\n... [truncated]";
      }
      if (err.length > LIMITS.OUTPUT_TRUNCATE) {
        err = err.slice(0, LIMITS.OUTPUT_TRUNCATE) + "\n... [truncated]";
      }

      return Response.json({ stdout: out, stderr: err, exitCode: 0 });
    } catch (err: any) {
      let out = err.stdout || "";
      let errStr = err.stderr || err.message || "Unknown error";
      if (out.length > LIMITS.OUTPUT_TRUNCATE) {
        out = out.slice(0, LIMITS.OUTPUT_TRUNCATE) + "\n... [truncated]";
      }
      if (errStr.length > LIMITS.OUTPUT_TRUNCATE) {
        errStr = errStr.slice(0, LIMITS.OUTPUT_TRUNCATE) + "\n... [truncated]";
      }

      return Response.json({
        stdout: out,
        stderr: errStr,
        exitCode: err.code ?? 1,
      });
    }
  } catch (error) {
    return Response.json(
      { error: (error as Error).message || "Internal error" },
      { status: 500 }
    );
  }
}
