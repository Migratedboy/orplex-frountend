import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getWorkspaceCwdForUser } from "@/lib/workspace-cwd";

export const dynamic = "force-dynamic";

/**
 * POST /api/agent/verify
 *
 * Runs browser verification: starts dev server, tests UI with Playwright,
 * captures screenshots, checks console errors, returns artifacts.
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json(
      { success: false, error: "Authentication required" },
      { status: 401 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const {
    runId,
    // Default to the CALLER's registered workspace folder — a bare "." would
    // verify Orplex's own installation directory instead of their project.
    // A client-supplied workDir is still honored but must exist under the
    // caller's own workspace when one is registered (see containment check).
    workDir: requestedWorkDir,
    devCommand = "npm run dev",
    port = 5000,
    path: pagePath = "/",
    width = 1280,
    height = 720,
    recordVideo = false,
    interactions = [],
    urlPolicy,
    browser,
  } = body;

  // Resolve the workDir: the user's own registered workspace by default; a
  // client override is accepted only when it stays inside the user's
  // registered workspace (prevents probing arbitrary server paths).
  const userWorkspace = getWorkspaceCwdForUser(session.user.id);
  let workDir = userWorkspace || ".";
  if (requestedWorkDir && typeof requestedWorkDir === "string") {
    if (!userWorkspace) {
      workDir = requestedWorkDir; // no registration — local desktop default
    } else {
      const { resolve, sep, isAbsolute } = await import("node:path");
      const root = resolve(userWorkspace);
      const candidate = isAbsolute(requestedWorkDir)
        ? resolve(requestedWorkDir)
        : resolve(root, requestedWorkDir);
      if (candidate === root || candidate.startsWith(root + sep)) {
        workDir = candidate;
      }
      // else: keep the user's own workspace — a stray/mismatched override
      // (e.g. from another session) must never redirect verification.
    }
  }

  try {
    const { verifyUI } = await import("@/lib/browser-verification");
    // Browser selection: explicit request wins; else use the machine's real
    // installed Chrome when present (genuine client fingerprints — fewer bot
    // walls, renders exactly like the user's own browser), falling back to
    // bundled Chromium. Detection is cached in the verification module.
    const { isInstalledChromeAvailable } = await import("@/lib/browser-verification");
    const effectiveBrowser = browser || ((await isInstalledChromeAvailable().catch(() => false)) ? "chrome" : undefined);
    const result = await verifyUI({
      workDir,
      devCommand,
      port,
      path: pagePath,
      width,
      height,
      recordVideo,
      interactions,
      urlPolicy,
      browser: effectiveBrowser,
    });

    // No runId supplied (e.g. the client-side worker's auto lane)? Persist
    // under an "ad-hoc" run + browser task so screenshots/timelines land in
    // the ArtifactPanel (which renders task-level artifacts) and can carry
    // pinned annotations.
    let effectiveRunId = runId;
    let effectiveTaskId: string | undefined = undefined;
    if (!effectiveRunId) {
      const run = await prisma.agentRun.create({
        data: {
          userId: session.user.id,
          prompt: `Browser verification: ${pagePath}`,
          status: result.success ? "done" : "failed",
          workspace: workDir,
          executionTarget: "server",
          completedAt: new Date(),
          verifyResult: {
            success: result.success,
            consoleErrors: result.consoleErrors.length,
            durationMs: result.durationMs,
          },
          tasks: {
            create: {
              role: "browser",
              title: `Verify ${pagePath} — ${result.success ? "PASS" : "FAIL"}`,
              status: result.success ? "done" : "failed",
              input: { pagePath, devCommand, port },
              output: {
                success: result.success,
                consoleErrors: result.consoleErrors.length,
                consoleWarnings: result.consoleWarnings.length,
                durationMs: result.durationMs,
              },
              startedAt: new Date(Date.now() - result.durationMs),
              completedAt: new Date(),
            },
          },
        },
        include: { tasks: true },
      });
      effectiveRunId = run.id;
      effectiveTaskId = run.tasks[0]?.id;
    }

    // Save artifacts to the database
    if (effectiveRunId && result.artifacts.length > 0) {
      const run = await prisma.agentRun.findFirst({
        where: { id: effectiveRunId, userId: session.user.id },
      });

      if (run) {
        for (const artifact of result.artifacts) {
          await prisma.agentArtifact.create({
            data: {
              runId: effectiveRunId,
              ...(effectiveTaskId ? { taskId: effectiveTaskId } : {}),
              kind: artifact.kind,
              name: artifact.name,
              mediaType: artifact.mediaType,
              content: artifact.content,
            },
          });
        }

        // Emit a verification event
        const maxSeq =
          (
            await prisma.runEvent.findFirst({
              where: { runId: effectiveRunId },
              orderBy: { sequence: "desc" },
              select: { sequence: true },
            })
          )?.sequence ?? -1;

        await prisma.runEvent.create({
          data: {
            // effectiveRunId: ad-hoc runs (no client runId) get their own run
            // row — the event must attach there, not to the empty original.
            runId: effectiveRunId,
            sequence: maxSeq + 1,
            type: "verification",
            payload: {
              success: result.success,
              errors: result.consoleErrors.length,
              warnings: result.consoleWarnings.length,
              duration: result.durationMs,
            },
          },
        });
      }
    }

    return NextResponse.json({
      success: true,
      // Caller can use this to correlate comments/annotations with the run
      runId: effectiveRunId,
      result: {
        ...result,
        // Don't return raw buffers
        screenshotBuffer: undefined,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A thrown verify = the harness itself broke (Playwright missing, spawn
    // crash…). Mark it so the agent never reads this as "my app failed".
    return NextResponse.json(
      { success: false, error: `infrastructure-failure: ${msg}` },
      { status: 500 }
    );
  }
}
