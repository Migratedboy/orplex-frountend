// task-ledger.test.ts — the service core extracted from /api/agent/ledger.
//
// The route-level contract is already pinned by route.test.ts (HTTP codes,
// prisma call shapes). This file pins the SERVICE invariants directly, so a
// future change to normalization fails here without HTTP involved:
// fail-closed payload rejection, the dual-shape normalization, the
// passed-lane → resolveKinds mapping, and the one-transaction persistence.

jest.mock("@/lib/prisma", () => ({
  prisma: {
    taskRun: { create: jest.fn(async () => ({ id: "run-1" })) },
    taskFailure: {
      upsert: jest.fn(async () => ({ id: "fail-1" })),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findMany: jest.fn(async () => []),
    },
    $transaction: jest.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
  },
}));

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  listOpenFailures,
  normalizeLedgerPayload,
  persistRunOutcome,
  workspaceKeyFrom,
} from "../task-ledger";

const mockedPrisma = prisma as unknown as {
  taskRun: { create: jest.Mock };
  taskFailure: { upsert: jest.Mock; updateMany: jest.Mock; findMany: jest.Mock };
  $transaction: jest.Mock;
};

const FLAT = {
  workspaceKey: "D:\\proj",
  task: "fix the build",
  mode: "code",
  finalStatus: "done",
  lanes: { typecheck: "pass", browser: "fail", swarm: "skipped" },
  durationMs: 65_000,
  modelCalls: 9,
  fullCalls: 5,
  compactCalls: 4,
  systemTokensSpent: 100,
  systemTokensFull: 160,
  tokensSaved: 60,
  savedPct: 37,
  failures: [
    { kind: "typecheck", detail: "TS2322 on line 9", files: ["src/a.ts"], count: 3 },
  ],
  passedLanes: ["typecheck"],
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("normalizeLedgerPayload — fail-closed rejection", () => {
  it("rejects non-object payloads, empty workspace keys, unknown statuses and missing lanes", () => {
    expect(normalizeLedgerPayload("nope")).toBeNull();
    expect(normalizeLedgerPayload(null)).toBeNull();
    expect(normalizeLedgerPayload({ task: "t", finalStatus: "done", lanes: {} })).toBeNull();
    expect(normalizeLedgerPayload({ ...FLAT, finalStatus: "running" })).toBeNull();
    expect(normalizeLedgerPayload({ ...FLAT, lanes: undefined })).toBeNull();
  });

  it("accepts both the flat and the nested (`run`) shape equivalently", () => {
    const nested = normalizeLedgerPayload({ run: FLAT, failures: FLAT.failures, passedLanes: ["typecheck"] });
    const flat = normalizeLedgerPayload(FLAT);
    expect(nested).toEqual(flat);
    expect(flat?.run.mode).toBe("code");
  });

  it("caps every unbounded field to the documented caps", () => {
    const normalized = normalizeLedgerPayload({
      ...FLAT,
      task: "x".repeat(9_000),
      failures: [
        // count: 0, weird detail, oversized list of escape-line files
        {
          kind: "browser",
          detail: " too long ".repeat(900).trim(),
          files: ["f".repeat(900), "o".repeat(900), "q".repeat(900), "z".repeat(900), "a".repeat(900), "b", "c"],
          count: 0,
        },
      ],
      tokensSaved: 1e12,
      savedPct: 9_000,
      durationMs: 4e12,
    });
    expect(normalized?.run.task.length).toBe(4_000);
    expect(normalized?.failures[0].detail.length).toBe(600);
    expect(normalized?.failures[0].files).toHaveLength(5);
    expect(normalized?.failures[0].count).toBe(1);
    expect(normalized?.run.savedPct).toBe(1_000);
    expect(normalized?.run.durationMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("maps passedLanes via LANE_TO_KIND and dedupes (swarm → review)", () => {
    const normalized = normalizeLedgerPayload({ ...FLAT, passedLanes: ["typecheck", "swarm", "swarm", "browser"] });
    expect(normalized?.resolveKinds).toEqual(["typecheck", "review", "browser"]);
  });

  it("keeps unknown lane names out of resolveKinds instead of throwing", () => {
    const normalized = normalizeLedgerPayload({ ...FLAT, passedLanes: ["quantum", null, 7] });
    expect(normalized?.resolveKinds).toEqual([]);
  });
});

describe("persistRunOutcome — one transaction, per-failure upserts", () => {
  const run = normalizeLedgerPayload(FLAT)!;

  it("creates the TaskRun row with normalized lanes", async () => {
    await persistRunOutcome(run);
    expect(mockedPrisma.taskRun.create).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.taskRun.create.mock.calls[0][0].data).toMatchObject({
      workspaceKey: "D:\\proj",
      finalStatus: "done",
      typecheckLane: "pass",
      browserLane: "fail",
      swarmLane: "skipped",
    });
  });

  it("upserts each failure under its sha256 detail identity", async () => {
    const detail = "TS2322 on line 9";
    const expectedHash = createHash("sha256").update(detail).digest("hex").slice(0, 32);
    await persistRunOutcome(run);
    expect(mockedPrisma.taskFailure.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceKey_kind_detailHash: { workspaceKey: "D:\\proj", kind: "typecheck", detailHash: expectedHash } },
        update: expect.objectContaining({ count: { increment: 3 } }),
      })
    );
    expect(mockedPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("resolves open failures for passed lanes", async () => {
    await persistRunOutcome(run);
    expect(mockedPrisma.taskFailure.updateMany).toHaveBeenCalledWith({
      where: { workspaceKey: "D:\\proj", kind: { in: ["typecheck"] }, resolvedAt: null },
      data: { resolvedAt: expect.any(Date) },
    });
  });

  it("writes nothing when the whole transaction fails (rethrow preservation)", async () => {
    mockedPrisma.$transaction.mockRejectedValueOnce(new Error("db down"));
    await expect(persistRunOutcome(run)).rejects.toThrow("db down");
  });
});

describe("workspaceKeyFrom / listOpenFailures — GET side", () => {
  it("coerces the workspace key fail-closed", () => {
    expect(workspaceKeyFrom("  D:\\proj ")).toBe("D:\\proj");
    expect(workspaceKeyFrom("   ")).toBeNull();
    expect(workspaceKeyFrom(42)).toBeNull();
    expect(workspaceKeyFrom("x".repeat(500))?.length).toBe(200);
  });

  it("maps prisma rows to the fetchLedgerFailures shape", async () => {
    mockedPrisma.taskFailure.findMany.mockResolvedValueOnce([
      {
        kind: "typecheck",
        detail: "TS2322",
        files: ["src/a.ts"],
        count: 2,
        lastSeenAt: new Date(1_700_000_000_000),
      },
    ]);
    const rows = await listOpenFailures("D:\\proj");
    expect(mockedPrisma.taskFailure.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceKey: "D:\\proj", resolvedAt: null },
        orderBy: { lastSeenAt: "desc" },
        take: 50,
      })
    );
    expect(rows[0]).toEqual({ kind: "typecheck", detail: "TS2322", files: ["src/a.ts"], count: 2, when: 1_700_000_000_000 });
  });

  it("survives a non-array files column", async () => {
    mockedPrisma.taskFailure.findMany.mockResolvedValueOnce([
      { kind: "browser", detail: "boom", files: { not: "an array" }, count: 1, lastSeenAt: new Date() },
    ]);
    const rows = await listOpenFailures("k");
    expect(rows[0].files).toEqual([]);
  });
});
