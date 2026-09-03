import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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
    workDir = ".",
    devCommand = "npm run dev",
    port = 3000,
    path: pagePath = "/",
    width = 1280,
    height = 720,
    recordVideo = false,
    interactions = [],
  } = body;

  try {
    const { verifyUI } = await import("@/lib/browser-verification");
    const result = await verifyUI({
      workDir,
      devCommand,
      port,
      path: pagePath,
      width,
      height,
      recordVideo,
      interactions,
    });

    // If a runId is provided, save artifacts to the database
    if (runId && result.artifacts.length > 0) {
      const run = await prisma.agentRun.findFirst({
        where: { id: runId, userId: session.user.id },
      });

      if (run) {
        for (const artifact of result.artifacts) {
          await prisma.agentArtifact.create({
            data: {
              runId,
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
              where: { runId },
              orderBy: { sequence: "desc" },
              select: { sequence: true },
            })
          )?.sequence ?? -1;

        await prisma.runEvent.create({
          data: {
            runId,
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
      result: {
        ...result,
        // Don't return raw buffers
        screenshotBuffer: undefined,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
