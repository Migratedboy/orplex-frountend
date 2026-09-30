import { z } from "zod";

export const runtimeVersion = 1 as const;

export const executionTargetSchema = z.enum(["local", "server"]);
export const autonomyPolicySchema = z.enum(["approval", "supervised", "autonomous"]);
export const agentRoleSchema = z.enum(["architect", "developer", "reviewer", "verifier"]);
export const taskStatusSchema = z.enum([
  "pending",
  "leased",
  "running",
  "waiting_approval",
  "verifying",
  "completed",
  "failed",
  "cancelled",
]);

export const runStatusSchema = z.enum([
  "pending",
  "planning",
  "executing",
  "verifying",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
]);

export const artifactSchema = z.object({
  kind: z.enum(["blueprint", "patch", "test", "diff", "log", "report"]),
  name: z.string().min(1).max(255),
  content: z.string(),
  mediaType: z.string().min(1).max(100),
});

export const createRunInputSchema = z.object({
  userId: z.string().min(1),
  prompt: z.string().min(1).max(500000),
  workspace: z.string().min(1).max(4096),
  executionTarget: executionTargetSchema.default("server"),
  autonomyPolicy: autonomyPolicySchema.default("approval"),
  idempotencyKey: z.string().min(1).max(255).optional(),
});

export const createTaskInputSchema = z.object({
  runId: z.string().min(1),
  role: agentRoleSchema,
  title: z.string().min(1).max(255),
  input: z.record(z.unknown()).default({}),
  dependsOn: z.array(z.string().min(1)).default([]),
});

export type ExecutionTarget = z.infer<typeof executionTargetSchema>;
export type AutonomyPolicy = z.infer<typeof autonomyPolicySchema>;
export type AgentRole = z.infer<typeof agentRoleSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type RuntimeArtifact = z.infer<typeof artifactSchema>;
export type CreateRunInput = z.input<typeof createRunInputSchema>;
export type CreateTaskInput = z.input<typeof createTaskInputSchema>;

export interface RuntimeEvent<T = Record<string, unknown>> {
  version: typeof runtimeVersion;
  type: string;
  runId: string;
  taskId?: string;
  sequence: number;
  payload: T;
  createdAt: string;
}