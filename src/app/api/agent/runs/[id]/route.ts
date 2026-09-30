import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import {
  cancelRuntimeRun,
  checkpointRuntimeRun,
  getRuntimeRun,
  runStatusSchema,
  sweepStaleRuns,
} from "@/lib/agent/runtime";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const { id } = await params;
  // Self-heal: if this run is an orphan from a crashed tab, fail it so the
  // detail view doesn't show a stuck "in progress" run.
  await sweepStaleRuns(session.user.id).catch(() => {});
  const run = await getRuntimeRun(session.user.id, id);
  if (!run) return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });
  return NextResponse.json({ success: true, run });
}

/**
 * PATCH /api/agent/runs/[id] — Client/server checkpoint of a run's status.
 *
 * Body: { status, result?, tokenUsage?, retries? }
 * Used by the live (browser) agent to mirror its task lifecycle into durable
 * AgentRun rows: created as "pending" on send, then moved to a terminal state
 * (completed / failed / cancelled) when the task settles. Ownership is
 * enforced — users can only checkpoint their own runs.
 */
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const { status, result, tokenUsage, retries } = body;

  if (typeof status !== "string" || !runStatusSchema.safeParse(status).success) {
    return NextResponse.json({
      success: false,
      error: `Invalid status: must be one of ${runStatusSchema.options.join(", ")}`,
    }, { status: 400 });
  }

  const checkpoint: {
    result?: unknown;
    tokenUsage?: number;
    retries?: number;
  } = {};
  if (result !== undefined) checkpoint.result = result;
  if (typeof tokenUsage === "number" && tokenUsage >= 0) checkpoint.tokenUsage = tokenUsage;
  if (typeof retries === "number" && retries >= 0) checkpoint.retries = retries;

  try {
    const run = await checkpointRuntimeRun(session.user.id, id, status, checkpoint);
    return NextResponse.json({ success: true, run });
  } catch {
    return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }

  const { id } = await params;
  try {
    await cancelRuntimeRun(session.user.id, id);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });
  }
}