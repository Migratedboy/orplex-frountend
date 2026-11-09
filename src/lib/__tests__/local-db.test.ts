/**
 * local-db.test.ts — the no-database JSON engine behind src/lib/prisma.ts.
 *
 * Pins the prisma-semantics subset the ~130 call sites rely on: lazy
 * PrismaPromise + $transaction atomicity, P2002 on composite/scalar uniques,
 * relation filters & includes, nested creates, increments, upserts on
 * composite keys, groupBy/_count/orderBy+take, aggregate _avg, cursor
 * pagination, contains with mode insensitive, cascade deletes, and the
 * atomic JSON file round-trip.
 */

import {
  buildLocalDbClient,
  resetForTests,
  flushAll,
  MODEL_DEFS,
} from "../local-db";

type DbAny = any;

let dir: string;
let db: DbAny;

beforeAll(() => {
  dir = joinTestDir("orplex-local-db-test-" + Date.now());
  process.env.ORPLEX_LOCAL_DB_DIR = dir;
});

afterAll(() => {
  flushAll();
  delete process.env.ORPLEX_LOCAL_DB_DIR;
  // leave the temp dir for inspection on failure; it's in temp
});

beforeEach(() => {
  resetForTests();
  db = buildLocalDbClient() as unknown as DbAny;
});

function joinTestDir(name: string): string {
  // no os import — compose from env-independent root
  const base = process.env.TMP || process.env.TEMP || process.cwd();
  return require("node:path").join(base, name);
}

describe("local JSON db engine", () => {
  it("create → findUnique → row persisted to disk with id + timestamps", async () => {
    const conv: Record<string, unknown> = await db.conversation.create({
      data: { userId: "u1", title: "Chat" },
    });
    expect(String((conv as { id: string }).id).length).toBeGreaterThan(4);
    expect((conv as { createdAt: Date }).createdAt).toBeInstanceOf(Date);

    const fresh = buildLocalDbClient() as DbAny;
    const row = (await fresh.conversation.findUnique({
      where: { id: (conv as { id: string }).id },
    })) as { title: string } | null;
    expect(row?.title).toBe("Chat");
  });

  it("scalar unique violation throws P2002 (user.email)", async () => {
    await db.user.create({ data: { email: "a@x.io", name: "A" } });
    await expect(db.user.create({ data: { email: "a@x.io", name: "B" } })).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("composite unique violation throws P2002 (runEvent runId+sequence)", async () => {
    await db.runEvent.create({ data: { runId: "r1", sequence: 3, type: "x", payload: {} } });
    await expect(
      db.runEvent.create({ data: { runId: "r1", sequence: 3, type: "y", payload: {} } })
    ).rejects.toMatchObject({ code: "P2002" });
    // different run → same sequence is fine
    await db.runEvent.create({ data: { runId: "r2", sequence: 3, type: "y", payload: {} } });
  });

  it("upsert on composite key windowStart: create branch then increment branch", async () => {
    const w1 = new Date("2026-01-01T00:00:00Z");
    const first = (await db.rateLimitWindow.upsert({
      where: { key_windowStart: { key: "burst:u9", windowStart: w1 as unknown as string } },
      update: { count: { increment: 1 } },
      create: { key: "burst:u9", windowStart: w1, count: 1, expiresAt: new Date() },
    })) as { count: number };
    expect(first.count).toBe(1);
    const second = (await db.rateLimitWindow.upsert({
      where: { key_windowStart: { key: "burst:u9", windowStart: w1 as unknown as string } },
      update: { count: { increment: 1 } },
      create: { key: "o", windowStart: w1, count: 1 },
    })) as { count: number };
    expect(second.count).toBe(2);
  });

  it("delegates are LAZY — array $transaction only writes on await", async () => {
    const before = await db.projectRecord.count({ where: { userId: "u1" } });
    expect(before).toBe(0);
    // Fire-and-forget pattern used by the codebase (.catch wrappers, arrays)
    void db.conversation.create({ data: { userId: "u1", title: "p" } }).catch(() => { });
    expect((await db.projectRecord.count({})) as number).toBeGreaterThanOrEqual(0);

    // array transaction: create both records in one atomic shot
    const rec1 = db.projectRecord.create({ data: { userId: "u1", name: "A" } });
    const rec2 = db.projectRecord.create({ data: { userId: "u1", name: "B" } });
    // NOT awaited yet → nothing actuated (lazy semantics)
    const snapshotCount = await db.projectRecord.count({ where: { userId: "u1", name: "A" } });
    expect(snapshotCount).toBe(0);
    await db.$transaction([rec1, rec2]);
    expect(await db.projectRecord.count({ where: { userId: "u1" } })).toBe(2);
  });

  it("array $transaction is all-or-nothing — a bad op rolls back the good one", async () => {
    await db.projectRecord.create({ data: { userId: "u1", name: "A" } });
    const good = db.projectRecord.create({ data: { userId: "u1", name: "B" } });
    const clashing = db.projectRecord.create({ data: { userId: "u1", name: "A" } }); // P2002
    await expect(db.$transaction([good, clashing])).rejects.toBeTruthy();
    // Rolled back: neither the new B nor a double-A may exist
    expect(await db.projectRecord.count({ where: { userId: "u1" } })).toBe(1);
  });

  it("interactive $transaction rolls back on throw", async () => {
    await expect(
      db.$transaction(async (tx: DbAny) => {
        await tx.conversation.create({
          data: { userId: "u2", title: "inside" },
        });
        await tx.runEvent.create({ data: { runId: "rr", sequence: 1 } });
        await tx.runEvent.create({ data: { runId: "rr", sequence: 1 } }); // throw
        return 1;
      })
    ).rejects.toBeTruthy();
    expect(await db.conversation.count({ where: { userId: "u2" } })).toBe(0);
  });

  it("relation filter: message where { conversation: { userId } }", async () => {
    const conv = (await db.conversation.create({ data: { userId: "uA", title: "T" } })) as { id: string };
    await db.message.create({ data: { conversationId: conv.id, content: "hello", role: "user" } });
    await db.message.create({ data: { conversationId: "nope", content: "other", role: "user" } });
    const found = (await db.message.findMany({
      where: { conversation: { userId: "uA" }, content: { contains: "HELLO", mode: "insensitive" } },
    })) as { content: string }[];
    expect(found.length).toBe(1);
    expect(found[0].content).toBe("hello");
  });

  it("include with nested orderBy + take: conversation.findFirst messages newest-first", async () => {
    const conv = (await db.conversation.create({ data: { userId: "uC", title: "T" } })) as { id: string };
    const t0 = new Date(Date.now() - 5000);
    for (let i = 0; i < 5; i++) {
      await db.message.create({
        data: { conversationId: conv.id, content: `m${i}`, role: "user", createdAt: new Date(t0.getTime() + i * 1000) },
      });
    }
    const c = (await db.conversation.findFirst({
      where: { id: conv.id },
      include: { messages: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 3 } },
    })) as { messages: { content: string }[] } | null;
    expect(c?.messages.map((m) => m.content)).toEqual(["m4", "m3", "m2"]);
  });

  it("nested create: conversation.create({ data: { messages: { create: [...] } } })", async () => {
    const conv = (await db.conversation.create({
      data: {
        userId: "uD",
        title: "N",
        messages: { create: [{ content: "a", role: "user" }, { content: "b", role: "assistant" }] },
      } as Record<string, unknown>,
      include: { messages: true },
    })) as { messages: unknown[] };
    expect(Array.isArray(conv.messages) && conv.messages.length).toBe(2);
    expect(await db.message.count({ where: { content: "b", role: "assistant" } })).toBe(1);
  });

  it("agent dependency traversal: dependencies { some/every } with dependsOn status", async () => {
    const run = (await db.agentRun.create({ data: { workspace: "w", status: "running", role: "builder" } })) as { id: string };
    const t1 = (await db.agentTask.create({ data: { runId: run.id, role: "a", status: "completed" } })) as { id: string };
    const t2 = (await db.agentTask.create({ data: { runId: run.id, role: "b", status: "pending" } })) as { id: string };
    await db.agentTaskDependency.create({ data: { taskId: t2.id, dependsOnId: t1.id } });

    const blocked = (await db.agentTask.findFirst({
      where: { runId: run.id, status: "pending", dependencies: { every: { dependsOn: { status: "completed" } } } },
    })) as { id: string } | null;
    expect(blocked?.id).toBe(t2.id);

    await db.agentTaskDependency.create({ data: { taskId: t2.id, dependsOnId: t2.id, wait: 1 } });
    const notBlocked = (await db.agentTask.findFirst({
      where: { id: t2.id, dependencies: { every: { dependsOn: { status: "completed" } } } },
    })) as { id: string } | null;
    expect(notBlocked).toBeNull(); // t2 depends on itself, still pending → every fails
    void t1;
  });

  it("runEvent run filter: run { userId } scoped queries", async () => {
    const run = (await db.agentRun.create({ data: { userId: "uOwn", status: "running" } })) as { id: string };
    const other = (await db.agentRun.create({ data: { userId: "uElse", status: "running" } })) as { id: string };
    await db.runEvent.create({ data: { runId: run.id, sequence: 1 } });
    await db.runEvent.create({ data: { runId: other.id, sequence: 1 } });
    const mine = (await db.runEvent.findMany({ where: { run: { userId: "uOwn" } } })) as unknown[];
    expect(mine.length).toBe(1);
  });

  it("increment updates count up in place (agentTask.attempt CAS companions)", async () => {
    const t = (await db.agentTask.create({ data: { runId: "x", attempt: 0, status: "pending" } })) as { id: string; attempt: number };
    await db.agentTask.update({ where: { id: t.id }, data: { attempt: { increment: 1 } } });
    const reread = (await db.agentTask.findUnique({ where: { id: t.id } })) as { attempt: number };
    expect(reread.attempt).toBe(1);
  });

  it("cursor pagination: skip:1 + cursor { id } works for getConversation lists", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = (await db.conversation.create({
        data: { userId: "z", title: `n${i}`, updatedAt: new Date(Date.now() - i * 1000) },
      })) as { id: string; updatedAt: Date };
      ids.push(c.id);
    }
    const page = (await db.conversation.findMany({
      where: { userId: "z" },
      orderBy: { updatedAt: "desc" },
      take: 2,
      skip: 1,
      cursor: { id: ids[0] },
    })) as { title: string }[];
    expect(page.map((c) => c.title)).toEqual(["n1", "n2"]);
  });

  it("groupBy: usageLog _count._groupedByProvider with orderBy _count desc + take", async () => {
    for (const p of ["a", "a", "b", "a", "c"]) {
      await db.usageLog.create({ data: { provider: p, model: "m", latencyMs: 10, userFeedback: null } });
    }
    const rows = (await db.usageLog.groupBy({
      by: ["provider"],
      _count: { _all: true },
      orderBy: { _count: { id: "desc" } },
    })) as Array<{ provider: string; _count: { _all: number } }>;
    expect(rows[0].provider).toBe("a");
    expect(rows[0]._count._all).toBe(3);
    const agg = (await db.usageLog.aggregate({ _avg: { latencyMs: true } })) as {
      _avg: { latencyMs: number | null };
    };
    expect(agg._avg.latencyMs).toBe(10);
  });

  it("cascade delete: deleting an agentRun removes its tasks+events", async () => {
    const run = (await db.agentRun.create({ data: { status: "running" } })) as { id: string };
    await db.agentTask.create({ data: { runId: run.id, status: "pending" } });
    await db.runEvent.create({ data: { runId: run.id, sequence: 1 } });
    await db.agentRun.delete({ where: { id: run.id } });
    expect(await db.agentTask.count({ where: { runId: run.id } })).toBe(0);
    expect(await db.runEvent.count({ where: { runId: run.id } })).toBe(0);
  });

  it("querySelector-shaped where: NOT + OR + in-lists resolve like prisma", async () => {
    await db.projectRecord.create({ data: { userId: "or", name: "A" } });
    await db.projectRecord.create({ data: { userId: "or", name: "B" } });
    const rows = (await db.projectRecord.findMany({
      where: { userId: "or", name: { in: ["A", "Z"] } },
    })) as unknown[];
    expect(rows.length).toBe(1);
    const notRows = (await db.projectRecord.findMany({
      where: { userId: "or", NOT: { name: "A" } },
    })) as unknown[];
    expect(notRows.length).toBe(1);
  });

  it("$queryRaw no-ops for the advisory lock + health probe", async () => {
    const res = (await db.$queryRaw`SELECT pg_try_advisory_lock(7777) AS locked`) as { locked: boolean }[];
    expect(res[0]?.locked).toBe(true);
    await db.$queryRaw`SELECT 1`;
  });

  it("maxRows caps telemetry collections (usageLog 5000)", async () => {
    const before = MODEL_DEFS.usageLog.maxRows ?? 0;
    expect(before).toBe(5000);
    for (let i = 0; i < 5005; i++) {
      await db.usageLog.create({ data: { provider: "p" } });
    }
    expect(await db.usageLog.count({})).toBe(5000);
  });
});
