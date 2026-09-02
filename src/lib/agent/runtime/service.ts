import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
  createRunInputSchema,
  createTaskInputSchema,
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

  return prisma.$transaction(async (transaction) => {
    const latest = await transaction.runEvent.findFirst({
      where: { runId: event.runId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const sequence = event.sequence > 0 ? event.sequence : (latest?.sequence ?? 0) + 1;

    return transaction.runEvent.create({
      data: {
        runId: event.runId,
        taskId: event.taskId,
        sequence,
        type: event.type,
        payload: serializeEvent(event),
        createdAt: new Date(event.createdAt),
      },
    });
  });
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

  return prisma.$transaction(async (transaction) => {
    const task = await transaction.agentTask.findFirst({
      where: {
        runId,
        status: "pending",
        dependencies: { every: { dependsOn: { status: "completed" } } },
      },
      orderBy: { createdAt: "asc" },
    });
    if (!task) return null;

    return transaction.agentTask.update({
      where: { id: task.id },
      data: {
        status: "running",
        leaseOwner,
        leaseUntil,
        attempt: { increment: 1 },
        startedAt: new Date(),
      },
    });
  });
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

export async function getRuntimeEvents(userId: string, runId: string, afterSequence = 0) {
  await assertRunOwner(runId, userId);

  return prisma.runEvent.findMany({
    where: { runId, sequence: { gt: Math.max(0, afterSequence) } },
    orderBy: { sequence: "asc" },
  });
}

async function assertRunOwner(runId: string, userId: string) {
  const run = await prisma.agentRun.findFirst({ where: { id: runId, userId }, select: { id: true } });
  if (!run) throw new Error("Runtime run not found");
}