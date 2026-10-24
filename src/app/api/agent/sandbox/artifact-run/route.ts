// POST /api/agent/sandbox/artifact-run — one-shot [ARTIFACT] code execution.
//
// The artifact modes (python script, node script) run in-full in a Vercel
// Sandbox VM: the files are uploaded, run inside a /vercel/sandbox workspace,
// and stdout/stderr/exitCode stream back to the UI console under the
// artifact card. Auth rides the session; screening is double (parser + the
// entry/size caps here). Streams are capped and VMs are per-user.

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { checkBurstLimit } from "@/lib/rate-limiter";
import { parseArtifactPayload } from "@/lib/artifact-sandbox";
import { isVercelSandboxAvailable, runSandboxCode } from "@/lib/vercel-sandbox";
import { publicErrorMessage } from "@/lib/errors";

export const maxDuration = 120;

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
    if (!(await isVercelSandboxAvailable())) {
      return Response.json({ error: "Sandbox execution is unavailable on this deployment." }, { status: 403 });
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = parseArtifactPayload(body);
    if (!parsed.ok || !parsed.artifact) {
      return Response.json({ error: parsed.error || "invalid artifact payload" }, { status: 400 });
    }

    const { files, entry, language } = parsed.artifact;
    const hasRequirements = language === "python" && files.some((f) => f.path === "requirements.txt");
    if (hasRequirements) {
      // Install deps first, then run the entry. A failed install stops the
      // run — the pip log is the error the user needs to see.
      const install = await runSandboxCode({
        userId, family: "exec", language,
        command: "pip",
        args: ["install", "-q", "-r", "requirements.txt"],
        files: files.map((f) => ({ path: f.path, content: f.content })),
        timeoutMs: 60_000,
        env: { PIP_ROOT_USER_ACTION: "ignore" },
      });
      if (install.exitCode !== 0) {
        return Response.json({
          stdout: install.stdout,
          stderr: install.stderr,
          exitCode: install.exitCode,
          stage: "install",
        });
      }
    }

    const cmd = language === "python" ? "python3" : "node";
    const run = await runSandboxCode({
      userId, family: "exec", language,
      ...(hasRequirements
        ? {} // deps already installed; skip re-upload to keep the run fast
        : { files: files.map((f) => ({ path: f.path, content: f.content })) }),
      command: cmd,
      args: [entry],
      timeoutMs: 60_000,
      env: language === "python" ? { PYTHONUNBUFFERED: "1" } : {},
    });
    return Response.json({
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
    });
  } catch (error) {
    return Response.json(
      { error: publicErrorMessage(error, "Sandbox run failed") },
      { status: 500 }
    );
  }
}
