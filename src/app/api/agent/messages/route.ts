import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { appendRuntimeEvent } from "@/lib/agent/runtime/service";
import { runtimeVersion, type RuntimeEvent } from "@/lib/agent/runtime/types";
import { publicErrorMessage } from "@/lib/errors";
import { checkBurstLimit } from "@/lib/rate-limiter";

export const dynamic = "force-dynamic";

const MAX_MESSAGE_CHARS = 4000;
/** Per-run queue cap: the executor consumes agent-message events on every
 * turn start, so a long-lived run only needs small burst headroom. */
const MAX_MESSAGES_PER_RUN = 100;
/** Statuses the executor consumes BETWEEN turns — steering is only meaningful
 * then. Terminal statuses never pick messages up again (executor restarts
 * re-queue runs as "pending", which is in this set). */
const ACTIVE_STATUSES = new Set(["pending", "planning", "executing", "verifying", "waiting_approval"]);

/**
 * POST /api/agent/messages — deliver a user message to a RUNNING agent run.
 *
 * The message becomes a RunEvent of type "agent-message"; the executor's
 * turn loop picks new ones up on the next turn start and injects them into
 * its transcript exactly like Claude Code's mid-run user steering. Nothing
 * here mutates the run itself: an arrived-but-unconsumed message is still
 * just an event until a live loop reads it.
 *
 * Body: { runId, body }
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const payload = (await request.json().catch(() => ({}))) as { runId?: unknown; body?: unknown };
  const runId = typeof payload.runId === "string" ? payload.runId : "";
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  if (!runId || !body) {
    return NextResponse.json({ success: false, error: "runId and body required" }, { status: 400 });
  }
  if (body.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json(
      { success: false, error: `Message too long (max ${MAX_MESSAGE_CHARS} characters)` },
      { status: 400 }
    );
  }
  if (!(await checkBurstLimit(session.user.id).catch(() => false))) {
    return NextResponse.json(
      { success: false, error: "Too many requests. Try again in about a minute." },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }

  // Ownership + honesty in ONE read: unknown/foreign runs and finished runs
  // are rejected BEFORE the event is appended — appending to a completed run
  // would report delivered:true for a message no turn loop will ever read.
  const run = await prisma.agentRun.findFirst({
    where: { id: runId, userId: session.user.id },
    select: { id: true, status: true },
  }).catch(() => null);
  if (!run) {
    return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });
  }
  if (!ACTIVE_STATUSES.has(run.status)) {
    return NextResponse.json(
      { success: false, error: "Run is not active — messages are only accepted while a run is in flight" },
      { status: 409 }
    );
  }

  const queued = await prisma.runEvent.count({
    where: { runId, type: "agent-message" },
  }).catch(() => 0);
  if (queued >= MAX_MESSAGES_PER_RUN) {
    return NextResponse.json(
      { success: false, error: "Message cap reached for this run" },
      { status: 429 }
    );
  }

  const event: RuntimeEvent<{ body: string; from: string }> = {
    version: runtimeVersion,
    type: "agent-message",
    runId,
    sequence: 0, // appendRuntimeEvent computes the next sequence
    payload: { body, from: session.user.id },
    createdAt: new Date().toISOString(),
  };

  try {
    await appendRuntimeEvent(session.user.id, event);
    return NextResponse.json({ success: true, delivered: true });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err, "Failed to deliver message") },
      { status: 500 }
    );
  }
}
