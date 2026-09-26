import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const MAX_BATCH = 8;
const DEFAULT_STAGGER_MINUTES = 30;
const MAX_STAGGER_MINUTES = 240;

/**
 * POST /api/agent/runs/batch — The morning PR queue.
 *
 * Body: { prompts: string[], staggerMinutes?: number, priority?: number, mode?: string }
 *
 * Enqueues up to 8 runs scheduled at staggered `notBefore` times so the
 * serial executor sips through them across the night (8k TPM compliant by
 * construction — never two runs at once, each delayed by the stagger).
 * Each claimed run lands on its own branch; push/PR links land in the
 * timeline (`pr-opened`) for the morning review.
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const prompts = Array.isArray(body.prompts) ? body.prompts.filter((p: unknown) => typeof p === "string" && p.trim()) : [];
  if (prompts.length === 0) {
    return NextResponse.json({ success: false, error: "prompts[] is required" }, { status: 400 });
  }
  if (prompts.length > MAX_BATCH) {
    return NextResponse.json({ success: false, error: `max ${MAX_BATCH} prompts per batch` }, { status: 400 });
  }

  const staggerMinutes = Number.isFinite(body.staggerMinutes)
    ? Math.min(Math.max(Math.floor(body.staggerMinutes), 1), MAX_STAGGER_MINUTES)
    : DEFAULT_STAGGER_MINUTES;
  const priority = Number.isInteger(body.priority) ? (body.priority as number) : 0;
  const modelOverride =
    typeof body.modelOverride === "string" && body.modelOverride.trim()
      ? body.modelOverride.trim().slice(0, 120)
      : null;

  const now = Date.now();
  const first = body.startAt && !Number.isNaN(Date.parse(body.startAt)) ? Date.parse(body.startAt) : now;

  const created = [];
  try {
    for (let i = 0; i < prompts.length; i++) {
      const prompt = (prompts[i] as string).trim().slice(0, 20_000);
      const notBefore = new Date(first + i * staggerMinutes * 60_000);
      const run = await prisma.agentRun.create({
        data: {
          userId: session.user.id,
          prompt,
          status: "pending",
          workspace: ".",
          executionTarget: "server",
          autonomyPolicy: typeof body.autonomyPolicy === "string" ? body.autonomyPolicy : "approval",
          ...(modelOverride ? { modelOverride } : {}),
          ...(priority !== 0 ? { priority } : {}),
          notBefore,
          idempotencyKey: `batch-${now}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        },
      });
      await prisma.runEvent
        .create({
          data: {
            runId: run.id,
            sequence: 0,
            type: "spawned",
            payload: { prompt, mode: "code", scheduledFor: notBefore.toISOString(), batchIndex: i },
          },
        })
        .catch(() => {});
      created.push({ id: run.id, notBefore: notBefore.toISOString() });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: msg, created }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    count: created.length,
    staggerMinutes,
    runs: created,
  });
}
