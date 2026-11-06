import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getWorkspaceCwdForUser, resolveWorkspaceCwd } from "@/lib/workspace-cwd";
import { withVerifySlot } from "@/lib/server-executor/verify-gate";
import { publicErrorMessage } from "@/lib/errors";
import { BROWSER_VERIFY_PORT } from "@/lib/ui-paths";

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
    // Dedicated verification port (4310) — NOT 5000, which is Orplex's own UI
    // server in the desktop app (a spawned dev server there dies with
    // EADDRINUSE, or the readiness probe silently "passes" against Orplex
    // itself and verifies the wrong app).
    port = BROWSER_VERIFY_PORT,
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
  let workDir: string | null = userWorkspace;
  if (!workDir) {
    // The in-memory registration is process-local — a dev-server restart
    // (hot reload, redeploy) empties it. Fall back to the durable
    // registration before anything else, so verify never silently retargets.
    workDir = await resolveWorkspaceCwd(session.user.id).catch(() => null);
  }
  if (!workDir && !requestedWorkDir) {
    // NO bare "." fallback: the Next server's CWD is Orplex's own install
    // directory, and its package.json EXISTS — so `npm run dev` would boot a
    // SECOND Orplex instance and "verify" the wrong app (LIVE failure class
    // 2026-11-06: DB down + fresh process ⇒ registration lookup dead).
    return NextResponse.json(
      { success: false, error: "No workspace is registered, so there is nothing to verify. Open your project folder again (sidebar → Open), then call verify_app once more." },
      { status: 422 }
    );
  }
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
  // Narrow (and harden): at least one branch above produced a real folder —
  // except when a MALFORMED (non-string) workDir override came in with no
  // registration. Refuse those too rather than verifying "." (Orplex).
  if (!workDir) {
    return NextResponse.json(
      { success: false, error: "No workspace is registered, so there is nothing to verify. Open your project folder again (sidebar → Open), then call verify_app once more." },
      { status: 422 }
    );
  }

  try {
    const { verifyUI } = await import("@/lib/browser-verification");
    // Browser selection: explicit request wins; else use the machine's real
    // installed Chrome when present (genuine client fingerprints — fewer bot
    // walls, renders exactly like the user's own browser), falling back to
    // bundled Chromium. Detection is cached in the verification module.
    const { isInstalledChromeAvailable } = await import("@/lib/browser-verification");
    const effectiveBrowser = browser || ((await isInstalledChromeAvailable().catch(() => false)) ? "chrome" : undefined);
    // Machine-wide verify slot: the executor serializes its verify lanes
    // through withVerifySlot (each slot is a dev-server boot, +0.5–1 GB RSS on
    // the 8GB budget machine, and two boots on one port collide). UI verifies
    // must contend for the SAME slot, not route around it.
    const result = await withVerifySlot(() =>
      verifyUI({
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
      })
    );

    // No runId supplied (e.g. the client-side worker's auto lane)? Persist
    // under an "ad-hoc" run + browser task so screenshots/timelines land in
    // the ArtifactPanel (which renders task-level artifacts) and can carry
    // pinned annotations.
    // ALL persistence below is BEST-EFFORT: it must never turn a completed
    // verification into a 5xx. LIVE-VALIDATED failure (2026-11-06 dev box):
    // the local Postgres was unreachable, prisma.agentRun.create threw, the
    // outer catch returned 500 "infrastructure-failure", and the agent read
    // its own SUCCESSFUL verification as if the harness had crashed —
    // "couldn't verify" on every single verify_app call. Artifact/ledger
    // loss during a DB outage is acceptable; verdict loss is not.
    let effectiveRunId = runId;
    let effectiveTaskId: string | undefined = undefined;
    try {
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
    } catch (persistErr) {
      // DB unreachable — keep the verdict flowing. Best-effort LOCAL mirror:
      // a .json file next to the other device-local state, so runs/artifacts
      // produced while the database is down are retrievable instead of lost
      // (a video/screenshot artifact bigger than the mirror cap is skipped —
      // the verdict itself is never at risk). Never 500 here.
      console.warn(
        "[verify] persistence failed (artifacts/ledger not saved for this read):",
        persistErr instanceof Error ? persistErr.message : persistErr
      );
      try {
        const { saveVerifyRunLocally } = await import("@/lib/local-run-store");
        if (!effectiveRunId) {
          effectiveRunId = saveVerifyRunLocally({
            userId: session.user.id,
            prompt: `Browser verification: ${pagePath}`,
            status: result.success ? "done" : "failed",
            workspace: workDir,
            verifyResult: {
              success: result.success,
              consoleErrors: result.consoleErrors.length,
              durationMs: result.durationMs,
            },
            task: {
              role: "browser",
              title: `Verify ${pagePath} — ${result.success ? "PASS" : "FAIL"}`,
              input: { pagePath, devCommand, port },
              output: {
                success: result.success,
                consoleErrors: result.consoleErrors.length,
                consoleWarnings: result.consoleWarnings.length,
                durationMs: result.durationMs,
              },
            },
            event: {
              type: "verification",
              payload: {
                success: result.success,
                errors: result.consoleErrors.length,
                warnings: result.consoleWarnings.length,
                duration: result.durationMs,
              },
            },
            artifacts: result.artifacts,
          });
        }
      } catch {}
    }

    return NextResponse.json({
      success: true,
      // Caller can use this to correlate comments/annotations with the run
      // (absent when persistence itself failed — check server logs for the
      // "[verify] persistence failed" warn).
      ...(effectiveRunId ? { runId: effectiveRunId } : {}),
      result: {
        ...result,
        // Don't return raw buffers
        screenshotBuffer: undefined,
      },
    });
  } catch (err) {
    // A thrown verify = the harness itself broke (Playwright missing, spawn
    // crash…). Mark it so the agent never reads this as "my app failed".
    // Raw err.message would leak git/Prisma internals — keep the marker,
    // redact the cause.
    return NextResponse.json(
      { success: false, error: `infrastructure-failure: ${publicErrorMessage(err, "verification harness failed")}` },
      { status: 500 }
    );
  }
}
