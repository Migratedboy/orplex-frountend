// route.test.ts — /api/agent/ledger: the endpoint run-ledger.ts posts to.
// Locks the auth contract (copied from exec/route.ts), the normalized
// persistence of task_runs + task_failures (which had ZERO writers before),
// the passed-lane resolution, and the GET shape fetchLedgerFailures expects.
// Prisma is injected as a mock — no database.

import { createHash } from "node:crypto";
import { POST, GET } from "../route";

jest.mock("next-auth", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("@/lib/auth", () => ({ jwtOnlyOptions: {} }));

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

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";

const mockedSession = getServerSession as jest.Mock;

function postRequest(body: unknown) {
  return {
    json: async () => body,
  } as never;
}

function getRequest(params: Record<string, string>) {
  return {
    nextUrl: { searchParams: new URLSearchParams(params) },
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedSession.mockResolvedValue({ user: { id: "user-1" } });
});

describe("POST /api/agent/ledger — auth (mirrors exec/route.ts)", () => {
  it("answers 401 Unauthorized without a session", async () => {
    mockedSession.mockResolvedValue(null);
    const res = await POST(postRequest({ workspaceKey: "k", task: "t" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(prisma.taskRun.create).not.toHaveBeenCalled();
  });

  it("never writes when the session has no user id", async () => {
    mockedSession.mockResolvedValue({});
    const res = await POST(postRequest({ workspaceKey: "k", task: "t" }));
    expect(res.status).toBe(401);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("POST /api/agent/ledger — payload validation (fail-closed)", () => {
  it("400s on a non-object body", async () => {
    const res = await POST(postRequest("nope"));
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });

  it("400s when workspaceKey is missing or empty", async () => {
    expect((await POST(postRequest({ task: "t", finalStatus: "done", lanes: {} }))).status).toBe(400);
    expect((await POST(postRequest({ workspaceKey: "  ", task: "t", finalStatus: "done", lanes: {} }))).status).toBe(400);
    expect(prisma.taskRun.create).not.toHaveBeenCalled();
  });

  it("400s on an unknown finalStatus", async () => {
    const res = await POST(
      postRequest({ workspaceKey: "k", task: "t", finalStatus: "mystery", lanes: {} })
    );
    expect(res.status).toBe(400);
  });

  it("400s when lanes is absent", async () => {
    const res = await POST(postRequest({ workspaceKey: "k", task: "t", finalStatus: "done" }));
    expect(res.status).toBe(400);
  });

  it("coerces unknown lane verdicts and junk fields to safe values", async () => {
    const res = await POST(
      postRequest({
        workspaceKey: "k",
        task: "t",
        mode: 42,
        finalStatus: "error",
        lanes: { typecheck: "MAYBE", browser: "pass", swarm: null },
        durationMs: "soon",
      })
    );
    expect(res.status).toBe(200);
    const data = (prisma.taskRun.create as jest.Mock).mock.calls[0][0].data;
    expect(data.typecheckLane).toBe("skipped");
    expect(data.browserLane).toBe("pass");
    expect(data.swarmLane).toBe("skipped");
    expect(data.mode).toBe("code"); // junk mode → default
    expect(data.durationMs).toBe(0);
    expect(data.finalStatus).toBe("error");
  });
});

describe("POST /api/agent/ledger — persistence", () => {
  const flatPayload = {
    workspaceKey: "orplex-local:demo",
    task: "fix the login flow",
    mode: "code",
    finalStatus: "done",
    lanes: { typecheck: "fail", browser: "pass", swarm: "skipped" },
    durationMs: 45_000,
  };

  it("persists the flat shape { workspaceKey, task, mode, finalStatus, lanes, durationMs }", async () => {
    const res = await POST(postRequest(flatPayload));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(prisma.taskRun.create).toHaveBeenCalledTimes(1);
    const data = (prisma.taskRun.create as jest.Mock).mock.calls[0][0].data;
    expect(data).toMatchObject({
      workspaceKey: "orplex-local:demo",
      task: "fix the login flow",
      mode: "code",
      finalStatus: "done",
      typecheckLane: "fail",
      browserLane: "pass",
      swarmLane: "skipped",
      durationMs: 45_000,
      modelCalls: 0,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("persists the nested buildFinalizePayload shape with economics", async () => {
    const res = await POST(
      postRequest({
        workspaceKey: "orplex-local:demo",
        run: {
          task: "t",
          mode: "code",
          finalStatus: "done",
          lanes: { typecheck: "pass", browser: "skipped", swarm: "pass" },
          modelCalls: 3,
          fullCalls: 1,
          compactCalls: 2,
          systemTokensSpent: 1000,
          systemTokensFull: 4000,
          tokensSaved: 500,
          savedPct: 12,
          durationMs: 9000,
        },
        failures: [],
        passedLanes: [],
      })
    );
    expect(res.status).toBe(200);
    const data = (prisma.taskRun.create as jest.Mock).mock.calls[0][0].data;
    expect(data).toMatchObject({
      modelCalls: 3,
      fullCalls: 1,
      compactCalls: 2,
      systemTokensSpent: 1000,
      systemTokensFull: 4000,
      tokensSaved: 500,
      savedPct: 12,
      durationMs: 9000,
      typecheckLane: "pass",
      swarmLane: "pass",
    });
  });

  it("upserts failure evidence keyed by workspace+kind+detailHash", async () => {
    const detail = "src/a.ts(10,5): error TS2345: Argument of type 'x'.";
    await POST(
      postRequest({
        ...flatPayload,
        failures: [{ kind: "typecheck", detail, files: ["src/a.ts"], count: 2 }],
        passedLanes: [],
      })
    );
    expect(prisma.taskFailure.upsert).toHaveBeenCalledTimes(1);
    const args = (prisma.taskFailure.upsert as jest.Mock).mock.calls[0][0];
    const expectedHash = createHash("sha256").update(detail).digest("hex").slice(0, 32);
    expect(args.where.workspaceKey_kind_detailHash).toEqual({
      workspaceKey: "orplex-local:demo",
      kind: "typecheck",
      detailHash: expectedHash,
    });
    expect(args.update.count).toEqual({ increment: 2 });
    expect(args.create.files).toEqual(["src/a.ts"]);
  });

  it("drops failure entries without a known kind or with empty detail", async () => {
    await POST(
      postRequest({
        ...flatPayload,
        failures: [
          { kind: "mystery", detail: "x", files: [], count: 1 },
          { kind: "typecheck", detail: "", files: [], count: 1 },
          "not-an-object",
        ],
        passedLanes: [],
      })
    );
    expect(prisma.taskFailure.upsert).not.toHaveBeenCalled();
  });

  it("resolves open signatures for lanes that passed", async () => {
    await POST(
      postRequest({
        ...flatPayload,
        failures: [],
        passedLanes: ["browser", "swarm", "typecheck"],
      })
    );
    expect(prisma.taskFailure.updateMany).toHaveBeenCalledTimes(1);
    const args = (prisma.taskFailure.updateMany as jest.Mock).mock.calls[0][0];
    // lane key → failure kind: browser→browser, swarm→review, typecheck→typecheck
    expect(args.where.kind.in).toEqual(["browser", "review", "typecheck"]);
    expect(args.where.workspaceKey).toBe("orplex-local:demo");
    expect(args.where.resolvedAt).toBeNull();
    expect(args.data.resolvedAt).toBeInstanceOf(Date);
  });

  it("skips the resolve write when no lane passed", async () => {
    await POST(postRequest({ ...flatPayload, passedLanes: [] }));
    expect(prisma.taskFailure.updateMany).not.toHaveBeenCalled();
  });

  it("maps a Prisma failure to a generic 500 { ok:false } — no internals leak", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    (prisma.taskRun.create as jest.Mock).mockRejectedValueOnce(new Error("boom: connection refused"));
    const res = await POST(postRequest(flatPayload));
    spy.mockRestore();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain("connection refused");
  });
});

describe("GET /api/agent/ledger — what hydrateFailureMemoryFromLedger reads", () => {
  it("401s without a session", async () => {
    mockedSession.mockResolvedValue(null);
    const res = await GET(getRequest({ workspaceKey: "k" }));
    expect(res.status).toBe(401);
  });

  it("400s without a workspaceKey", async () => {
    const res = await GET(getRequest({}));
    expect(res.status).toBe(400);
    expect(prisma.taskFailure.findMany).not.toHaveBeenCalled();
  });

  it("returns only unresolved failures in the client's expected shape", async () => {
    (prisma.taskFailure.findMany as jest.Mock).mockResolvedValue([
      {
        kind: "typecheck",
        detail: "src/a.ts(1,1): error TS1005: expected.",
        files: ["src/a.ts"],
        count: 3,
        lastSeenAt: new Date(1_760_000_000_000),
      },
      { kind: "review", detail: "review noted", files: null, count: 1, lastSeenAt: new Date(1) },
    ]);

    const res = await GET(getRequest({ workspaceKey: "orplex-local:demo" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.failures).toEqual([
      { kind: "typecheck", detail: "src/a.ts(1,1): error TS1005: expected.", files: ["src/a.ts"], count: 3, when: 1_760_000_000_000 },
      { kind: "review", detail: "review noted", files: [], count: 1, when: 1 },
    ]);
    const args = (prisma.taskFailure.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where).toEqual({ workspaceKey: "orplex-local:demo", resolvedAt: null });
    expect(args.take).toBe(50);
  });

  it("degrades to 500 when the DB is unreachable", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    (prisma.taskFailure.findMany as jest.Mock).mockRejectedValue(new Error("db down"));
    const res = await GET(getRequest({ workspaceKey: "k" }));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
  });
});
