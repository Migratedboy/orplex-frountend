import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
  createRunInputSchema,
  createTaskInputSchema,
  runStatusSchema,
  type CreateRunInput,
  type CreateTaskInput,
  type RuntimeArtifact,
  type RuntimeEvent,
} from "./types";

function serializeEvent<T>(event: RuntimeEvent<T>) {
  return JSON.parse(JSON.stringify({
    version: event.version,
    type: event.type,
    payload: event.payload,
    createdAt: event.createdAt,
  })) as Prisma.InputJsonValue;
}

export async function createRuntimeRun(input: CreateRunInput) {
  const data = createRunInputSchema.parse(input);

  if (data.idempotencyKey) {
    const existing = await prisma.agentRun.findFirst({
      where: { userId: data.userId, idempotencyKey: data.idempotencyKey },
    });
    if (existing) return existing;
  }

  return prisma.$transaction(async (transaction) => {
    const run = await transaction.agentRun.create({
      data: {
        userId: data.userId,
        prompt: data.prompt,
        workspace: data.workspace,
        executionTarget: data.executionTarget,
        autonomyPolicy: data.autonomyPolicy,
        idempotencyKey: data.idempotencyKey,
        status: "planning",
      },
    });

    await transaction.agentTask.create({
      data: {
        runId: run.id,
        role: "architect",
        title: "Create implementation blueprint",
        input: { prompt: data.prompt },
      },
    });

    return run;
  });
}

export async function createRuntimeTask(input: CreateTaskInput, userId: string) {
  const data = createTaskInputSchema.parse(input);
  await assertRunOwner(data.runId, userId);

  return prisma.$transaction(async (transaction) => {
    const task = await transaction.agentTask.create({
      data: {
        runId: data.runId,
        role: data.role,
        title: data.title,
        input: data.input as Prisma.InputJsonObject,
        dependencies: {
          create: data.dependsOn.map((dependsOnId) => ({ dependsOnId })),
        },
      },
    });
    return task;
  });
}

export async function appendRuntimeEvent<T>(
  userId: string,
  event: RuntimeEvent<T>
) {
  await assertRunOwner(event.runId, userId);

  // The (runId, sequence) unique index is the authority. Compute the next
  // sequence optimistically, then let the INSERT arbitrate: on a unique-
  // constraint collision (a concurrent writer won the race) re-read the max
  // sequence and retry. P2002 is Prisma's unique-constraint error code.
  const P2002 = "P2002";
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      let sequence = event.sequence;
      if (sequence <= 0) {
        const latest = await prisma.runEvent.findFirst({
          where: { runId: event.runId },
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        });
        sequence = (latest?.sequence ?? 0) + 1;
      }

      return await prisma.runEvent.create({
        data: {
          runId: event.runId,
          taskId: event.taskId,
          sequence,
          type: event.type,
          payload: serializeEvent(event),
          createdAt: new Date(event.createdAt),
        },
      });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code !== P2002 || attempt === 4) throw err;
      // Lost the sequence race — loop and recompute.
    }
  }
  throw new Error("unreachable: appendRuntimeEvent retry loop");
}

export async function checkpointRuntimeRun(
  userId: string,
  runId: string,
  status: string,
  data: { result?: unknown; tokenUsage?: number; retries?: number } = {}
) {
  await assertRunOwner(runId, userId);

  return prisma.agentRun.update({
    where: { id: runId },
    data: {
      status,
      result: data.result === undefined
        ? undefined
        : data.result === null
          ? Prisma.JsonNull
          : data.result as Prisma.InputJsonValue,
      tokenUsage: data.tokenUsage,
      retries: data.retries,
      completedAt: ["completed", "failed", "cancelled"].includes(status) ? new Date() : undefined,
    },
  });
}

export async function leaseNextRuntimeTask(userId: string, runId: string, leaseOwner: string) {
  await assertRunOwner(runId, userId);
  const leaseUntil = new Date(Date.now() + 5 * 60 * 1000);

  // Read the candidate task OUTSIDE the write transaction, then claim it with
  // an atomic compare-and-set: updateMany only flips the row if it is still
  // pending. Two concurrent workers can select the same task, but only one
  // CAS succeeds; the loser sees 0 updated rows and picks the next task.
  const task = await prisma.agentTask.findFirst({
    where: {
      runId,
      status: "pending",
      dependencies: { every: { dependsOn: { status: "completed" } } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (!task) return null;

  const claimed = await prisma.agentTask.updateMany({
    where: { id: task.id, status: "pending" },
    data: {
      status: "running",
      leaseOwner,
      leaseUntil,
      attempt: { increment: 1 },
      startedAt: new Date(),
    },
  });
  if (claimed.count === 0) return null; // another worker claimed it — try again next poll

  return prisma.agentTask.findUnique({ where: { id: task.id } });
}

export async function completeRuntimeTask(
  userId: string,
  taskId: string,
  output: unknown
) {
  const task = await prisma.agentTask.findFirst({
    where: { id: taskId, run: { userId } },
    select: { id: true, runId: true },
  });
  if (!task) throw new Error("Runtime task not found");

  return prisma.agentTask.update({
    where: { id: task.id },
    data: {
      status: "completed",
      output: output === null ? Prisma.JsonNull : output as Prisma.InputJsonValue,
      leaseOwner: null,
      leaseUntil: null,
      completedAt: new Date(),
    },
  });
}

export async function failRuntimeTask(userId: string, taskId: string, error: string) {
  const task = await prisma.agentTask.findFirst({
    where: { id: taskId, run: { userId } },
    select: { id: true },
  });
  if (!task) throw new Error("Runtime task not found");

  return prisma.agentTask.update({
    where: { id: task.id },
    data: { status: "failed", error: error.slice(0, 10000), leaseOwner: null, leaseUntil: null },
  });
}

export async function recordRuntimeArtifact(
  userId: string,
  runId: string,
  artifact: RuntimeArtifact,
  taskId?: string
) {
  await assertRunOwner(runId, userId);

  return prisma.agentArtifact.create({
    data: {
      runId,
      taskId,
      kind: artifact.kind,
      name: artifact.name,
      mediaType: artifact.mediaType,
      content: artifact.content,
    },
  });
}

export async function cancelRuntimeRun(userId: string, runId: string) {
  await assertRunOwner(runId, userId);

  return prisma.$transaction([
    prisma.agentTask.updateMany({
      where: { runId, status: { in: ["pending", "leased", "running", "verifying"] } },
      data: { status: "cancelled", leaseOwner: null, leaseUntil: null },
    }),
    prisma.agentRun.update({
      where: { id: runId },
      data: { status: "cancelled", completedAt: new Date() },
    }),
  ]);
}

export async function getRuntimeRun(userId: string, runId: string) {
  return prisma.agentRun.findFirst({
    where: { id: runId, userId },
    include: {
      tasks: { orderBy: { createdAt: "asc" }, include: { dependencies: true, artifacts: true } },
      events: { orderBy: { sequence: "asc" } },
      artifacts: { orderBy: { createdAt: "asc" } },
      approvals: { orderBy: { createdAt: "asc" } },
    },
  });
}

export async function getRuntimeEvents(userId: string, runId: string, afterSequence = -1) {
  await assertRunOwner(runId, userId);

  return prisma.runEvent.findMany({
    // afterSequence = -1 (the initial fetch) includes sequence 0 — the
    // executor's `spawned` event lives at sequence 0 and was previously
    // invisible on the timeline (off-by-one on the first render).
    where: { runId, sequence: { gt: Math.max(-1, afterSequence) } },
    orderBy: { sequence: "asc" },
  });
}

// Terminal statuses never need sweeping; everything else is "in progress"
const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"];
const ACTIVE_RUN_STATUSES = runStatusSchema.options.filter(
  (s) => !TERMINAL_RUN_STATUSES.includes(s)
);
const ACTIVE_TASK_STATUSES = ["pending", "leased", "running", "verifying"];

/**
 * Fail runs stuck in an in-progress state past the staleness window.
 *
 * The live agent mirrors its tasks into AgentRun rows from the browser. When a
 * tab crashes (or the browser is closed mid-task), the terminal checkpoint
 * never arrives and the run stays "pending"/"executing" forever — a ghost that
 * keeps the board's active badge lit. Any in-flight tasks on those runs are
 * cancelled and the run itself is marked failed.
 *
 * Call lazily from the read paths (runs GET, board feed) — cheap when nothing
 * is stale, and those endpoints poll frequently enough to self-heal.
 *
 * @returns number of runs swept
 */
export async function sweepStaleRuns(userId: string, staleMs = 30 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);

  const stale = await prisma.agentRun.findMany({
    where: {
      userId,
      status: { in: ACTIVE_RUN_STATUSES },
      createdAt: { lt: cutoff },
    },
    select: { id: true },
  });

  if (stale.length === 0) return 0;

  const ids = stale.map((r) => r.id);
  await prisma.$transaction([
    prisma.agentTask.updateMany({
      where: { runId: { in: ids }, status: { in: ACTIVE_TASK_STATUSES } },
      data: { status: "cancelled", leaseOwner: null, leaseUntil: null },
    }),
    prisma.agentRun.updateMany({
      where: { id: { in: ids } },
      data: { status: "failed", completedAt: new Date() },
    }),
  ]);

  return stale.length;
}

async function assertRunOwner(runId: string, userId: string) {
  const run = await prisma.agentRun.findFirst({ where: { id: runId, userId }, select: { id: true } });
  if (!run) throw new Error("Runtime run not found");
}