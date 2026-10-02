import {
  autonomyPolicySchema,
  createRunInputSchema,
  createTaskInputSchema,
  executionTargetSchema,
} from "../types";

describe("runtime contracts", () => {
  it("applies safe defaults to a run", () => {
    expect(createRunInputSchema.parse({
      userId: "user-1",
      prompt: "Implement a feature",
      workspace: "C:/workspace",
    })).toMatchObject({
      executionTarget: "server",
      autonomyPolicy: "approval",
    });
  });

  it("rejects invalid execution policies", () => {
    expect(autonomyPolicySchema.safeParse("unrestricted").success).toBe(false);
    expect(executionTargetSchema.safeParse("remote").success).toBe(false);
  });

  it("requires a task title and role", () => {
    expect(createTaskInputSchema.safeParse({ runId: "run-1" }).success).toBe(false);
  });
});
