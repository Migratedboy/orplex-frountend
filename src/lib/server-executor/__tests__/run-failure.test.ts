/**
 * run-failure.test.ts — regression for the ghost-run defect (Operation Zero
 * Failure, BUG-004).
 *
 * A run that throws OUTSIDE executeRun's internal try (credential resolution,
 * workspace resolution) used to land in the poll loop's bare `.catch`, which
 * only bumped a counter — the AgentRun row stayed "executing" forever: the UI
 * showed an active run that would never complete and the lease loop never
 * revisited it. markRunFailed is the durable terminal-status write; these
 * tests pin that it writes "failed" + a summary + completedAt, and that a DB
 * outage on that write is logged, never thrown.
 */
import { markRunFailed } from "../executor";

const mockUpdate = jest.fn();
jest.mock("@/lib/prisma", () => ({
  prisma: { agentRun: { update: (...a: unknown[]) => mockUpdate(...a) } },
}));
jest.mock("@/lib/runtime-log", () => ({
  recordRuntimeLog: jest.fn(),
}));

describe("markRunFailed — a crashed run must reach a terminal status", () => {
  beforeEach(() => {
    mockUpdate.mockReset();
  });

  it("writes status failed with a summary and completedAt", async () => {
    mockUpdate.mockResolvedValueOnce({});
    await markRunFailed("run-abc123", "connect ECONNREFUSED");
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const arg = mockUpdate.mock.calls[0][0] as {
      where: { id: string };
      data: { status: string; result: { summary: string }; completedAt: Date };
    };
    expect(arg.where.id).toBe("run-abc123");
    expect(arg.data.status).toBe("failed");
    expect(arg.data.result.summary).toContain("Run crashed before completion");
    expect(arg.data.result.summary).toContain("ECONNREFUSED");
    expect(arg.data.completedAt).toBeInstanceOf(Date);
  });

  it("caps the error message in the summary (no unbounded DB payloads)", async () => {
    mockUpdate.mockResolvedValueOnce({});
    await markRunFailed("run-abc123", "x".repeat(10_000));
    const arg = mockUpdate.mock.calls[0][0] as { data: { result: { summary: string } } };
    expect(arg.data.result.summary.length).toBeLessThan(600);
  });

  it("never throws when the DB write fails (poll loop must keep leasing)", async () => {
    mockUpdate.mockRejectedValueOnce(new Error("P1001: can't reach database"));
    await expect(markRunFailed("run-abc123", "boom")).resolves.toBeUndefined();
  });
});
