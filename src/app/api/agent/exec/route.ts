// API route for real terminal command execution
// The background worker (client-side) calls this to run commands on the user's
// machine — full PATH (npm/node/git all resolve), the user's workspace as cwd,
// secrets still stripped from the environment.
//
// SECURITY MODEL: this route executes the caller's command in the CALLER's
// registered workspace, never another user's. Commands are additionally
// screened by isCommandAllowed (see lib/exec-guard.ts), which catches
// blocklist-evasion forms (env/var assignments, subshells, base64 pipes,
// newline-joined payloads) that the old substring matcher missed.
// Deployments that expose this API to untrusted users must run with
// AGENT_EXEC_DISABLED=1 (see checkExecEnabled below) and use run_in_sandbox.

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { checkBurstLimit } from "@/lib/rate-limiter";
import { isCommandAllowed, buildSafeEnv } from "@/lib/exec-guard";
import { TIMEOUTS, LIMITS } from "@/lib/constants";
import { getWorkspaceCwdForUser } from "@/lib/workspace-cwd";
import { dispatchSandbox, isSandboxConfigured } from "@/lib/ci-sandbox";
import {
  isVercelSandboxAvailable,
  runShellCommand,
  languageFromCommand,
} from "@/lib/vercel-sandbox";
import { publicErrorMessage } from "@/lib/errors";

// Sandbox runs budget up to 90s in-VM; let the function live long enough.
export const maxDuration = 120;

/**
 * Kill switch for hosted deployments. Set AGENT_EXEC_DISABLED=1 anywhere the
 * server is reachable by untrusted users: it hard-disables local command
 * execution while leaving every other agent feature working (the worker
 * surfaces a clear message and users fall back to run_in_sandbox).
 */
export function checkExecEnabled(): boolean {
  return process.env.AGENT_EXEC_DISABLED !== "1";
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    const userId = session?.user?.id;
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!(await checkBurstLimit(userId).catch(() => false))) {
      return Response.json({ error: "Too many requests. Try again in about a minute." }, { status: 429, headers: { "Retry-After": "60" } });
    }

    if (!checkExecEnabled()) {
      // Hard-disabled local exec. Prefer the Vercel Sandbox lane when this
      // deployment can use it: the command runs (`sh -c`) inside an isolated
      // micro VM that auths via our own deployment OIDC identity — no local
      // filesystem, no stored keys. GitHub Actions remains the fallback, and
      // the honest 403 is the last resort. Same auth, same exec-guard screening.
      if (await isVercelSandboxAvailable()) {
        const { command, timeout } = await request.json().catch(() => ({}) as { command?: string; timeout?: number });
        if (!command || typeof command !== "string") {
          return Response.json({ error: "No command provided" }, { status: 400 });
        }
        if (command.length > 4000) {
          return Response.json({ error: "Command too long" }, { status: 400 });
        }
        const guard = isCommandAllowed(command);
        if (!guard.allowed) {
          return Response.json({ stdout: "", stderr: `BLOCKED: ${guard.reason}`, exitCode: 126 });
        }
        try {
          const run = await runShellCommand({
            userId,
            family: "exec",
            language: languageFromCommand(command),
            shell: command,
            timeoutMs: Math.min(typeof timeout === "number" && timeout > 0 ? timeout : TIMEOUTS.SANDBOX_EXEC, TIMEOUTS.SANDBOX_EXEC),
          });
          return Response.json({ stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode, sandbox: "vercel" });
        } catch (err) {
          return Response.json({
            stdout: "",
            stderr: `sandbox dispatch failed: ${(err as Error).message}`,
            exitCode: 125,
          });
        }
      }
      // No VM lane — ephemeral GitHub Actions runner (see ci-sandbox.ts
      // + agent-sandbox.yml). Same auth, same exec-guard screening.
      if (isSandboxConfigured()) {
        const { command, timeout } = await request.json().catch(() => ({}) as { command?: string; timeout?: number });
        if (!command || typeof command !== "string") {
          return Response.json({ error: "No command provided" }, { status: 400 });
        }
        if (command.length > 4000) {
          return Response.json({ error: "Command too long" }, { status: 400 });
        }
        const sandboxed = await dispatchSandbox(command, {
          timeoutMs: Math.min(typeof timeout === "number" && timeout > 0 ? timeout : TIMEOUTS.SANDBOX_EXEC, TIMEOUTS.SANDBOX_EXEC),
        });
        return Response.json({
          stdout: sandboxed.stdout,
          stderr: sandboxed.stderr,
          exitCode: sandboxed.exitCode,
          sandbox: true,
        });
      }
      return Response.json(
        {
          error:
            "Command execution is disabled on this deployment (AGENT_EXEC_DISABLED=1). Use run_in_sandbox for isolated execution.",
          disabled: true,
        },
        { status: 403 }
      );
    }

    const { command, timeout, maxBuffer } = await request.json();
    if (!command || typeof command !== "string") {
      return Response.json({ error: "No command provided" }, { status: 400 });
    }
    if (command.length > 4000) {
      return Response.json({ error: "Command too long" }, { status: 400 });
    }

    // Block dangerous commands — including evasion forms the old substring
    // matcher missed (FOO=rm sh payloads, $(...) substitution, base64|sh, …).
    const guard = isCommandAllowed(command);
    if (!guard.allowed) {
      return Response.json({
        stdout: "",
        stderr: `BLOCKED: ${guard.reason}`,
        exitCode: 126,
      });
    }

    // Dynamic import — server-side only
    const { exec: rawExec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(rawExec);

    const isWin = process.platform === "win32";

    // REAL terminal: inherit the full environment so npm/node/git/python all
    // resolve — only secret-valued keys are stripped (see buildSafeEnv).
    const safeEnv = buildSafeEnv();

    // Run in THIS user's registered workspace folder when one is open —
    // commands like `npm install` must operate on the user's project, not
    // Orplex's own installation directory, and never another user's.
    const workspace = getWorkspaceCwdForUser(userId);
    const cwd = workspace || process.cwd();

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: Math.min(
          typeof timeout === "number" && timeout > 0 ? timeout : TIMEOUTS.SANDBOX_EXEC,
          TIMEOUTS.SANDBOX_EXEC
        ),
        // Clamp caller-supplied maxBuffer: an unbounded buffer (e.g. 1e9)
        // lets one command OOM the server. Never exceed the platform cap.
        maxBuffer: Math.min(
          typeof maxBuffer === "number" && maxBuffer > 0 ? maxBuffer : LIMITS.EXEC_BUFFER,
          LIMITS.EXEC_BUFFER
        ),
        cwd,
        env: safeEnv as NodeJS.ProcessEnv,
        shell: isWin ? (process.env.ComSpec || "cmd.exe") : "/bin/sh",
        // Windows: kill the whole process TREE on timeout, not just the shell —
        // otherwise cmd.exe dies and orphaned node children keep running (and
        // holding ports) forever. exec's builtin timeout uses taskkill /T here.
        ...(isWin
          ? { killSignal: "SIGTERM" as const }
          : {}),
        // Client disconnect (Stop pressed / tab closed) kills the child instead
        // of letting it run until the timeout.
        signal: request.signal,
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

      return Response.json({ stdout: out, stderr: err, exitCode: 0, cwd });
    } catch (err: any) {
      // Client aborted (Stop / closed tab) — the child was killed by the signal.
      // The response is moot (the socket is gone) but the handler must not 500.
      if (err?.name === "AbortError" || request.signal.aborted) {
        return Response.json({
          stdout: "",
          stderr: "Command aborted (client disconnected)",
          exitCode: 130,
        });
      }

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
      { error: publicErrorMessage(error, "Internal error") },
      { status: 500 }
    );
  }
}
