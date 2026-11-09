/**
 * memory-isolation.test.ts — per-user scoping of the markdown memory store
 * (Mission 10 repair): every MemoryFile read/write must carry the caller's
 * userId, so one user can never read, overwrite, or delete another's files.
 *
 * Prisma is mocked with an in-memory table that honors the same
 * `where: { userId_path }` / `where: { userId }` shapes the real store uses.
 */
import { jest } from "@jest/globals";

interface Row { userId: string; path: string; content: string; version: number }

const table: Row[] = [];

type WhereUnique = { userId_path: { userId: string; path: string } };
type WhereUser = { userId: string };

const matchesWhere = (row: Row, w: WhereUnique | WhereUser | Record<string, never>): boolean => {
  if ("userId_path" in w) return row.userId === w.userId_path.userId && row.path === w.userId_path.path;
  if ("userId" in w && typeof w.userId === "string") return row.userId === w.userId;
  return true;
};

const memoryFileDelegate = {
  findMany: async ({ where }: { where?: WhereUser }) => table.filter((r) => matchesWhere(r, where ?? {})),
  findUnique: async ({ where }: { where: WhereUnique }) => table.find((r) => matchesWhere(r, where)) ?? null,
  create: async ({ data }: { data: Row }) => {
    table.push({ ...data });
    return data;
  },
  update: async ({ where, data }: { where: WhereUnique; data: Partial<Row> }) => {
    const row = table.find((r) => matchesWhere(r, where));
    if (row) Object.assign(row, data);
    return row ?? null;
  },
  delete: async ({ where }: { where: WhereUnique }) => {
    const i = table.findIndex((r) => matchesWhere(r, where));
    if (i >= 0) table.splice(i, 1);
    return {};
  },
};

jest.mock("../prisma", () => ({
  prisma: { memoryFile: memoryFileDelegate, memorySetting: {
    findUnique: async () => null,
  } },
}));

import {
  memoryList,
  memoryRead,
  memoryWrite,
  memoryStrReplace,
  memoryAppend,
  memoryDelete,
  loadMemoryContext,
} from "../memory-store";

beforeEach(() => {
  table.length = 0;
});

describe("memory-store user isolation", () => {
  it("writes are private: user B cannot read user A's file", async () => {
    await memoryWrite("/preferences.md", "docs: concise", "new", "user-A");
    await expect(memoryRead("/preferences.md", "user-B")).resolves.toEqual([]);
    await expect(memoryList("user-A")).resolves.toHaveLength(1);
    await expect(memoryList("user-B")).resolves.toEqual([]);
  });

  it("the same path can exist independently per user", async () => {
    await memoryWrite("/profile.md", "A profile", "new", "user-A");
    await memoryWrite("/profile.md", "B profile", "new", "user-B");
    const [a] = await memoryRead("/profile.md", "user-A");
    const [b] = await memoryRead("/profile.md", "user-B");
    expect(a.content).toBe("A profile");
    expect(b.content).toBe("B profile");
  });

  it("updates are scoped: B's edit cannot touch A's row", async () => {
    await memoryWrite("/topics/prefs.md", "v1", "new", "user-A");
    const res = await memoryStrReplace("/topics/prefs.md", "v1", "v2", 1, "user-B");
    expect(res.conflict).toBe(true);
    const [a] = await memoryRead("/topics/prefs.md", "user-A");
    expect(a.content).toBe("v1");
  });

  it("append creates only in the caller's namespace", async () => {
    await memoryAppend("/preferences.md", "appended", "new", "user-B");
    await expect(memoryRead("/preferences.md", "user-A")).resolves.toEqual([]);
  });

  it("delete removes only the caller's own file", async () => {
    await memoryWrite("/profile.md", "A", "new", "user-A");
    await memoryDelete("/profile.md", 1, "user-B");
    await expect(memoryList("user-A")).resolves.toHaveLength(1);
    await memoryDelete("/profile.md", 1, "user-A");
    await expect(memoryList("user-A")).resolves.toEqual([]);
  });

  it("loadMemoryContext never surfaces another user's files", async () => {
    await memoryWrite("/preferences.md", "A secret pref", "new", "user-A");
    const ctxB = await loadMemoryContext("user-B");
    expect(ctxB?.preferences ?? "").not.toContain("A secret pref");
    const ctxA = await loadMemoryContext("user-A");
    expect(ctxA?.preferences).toContain("A secret pref");
  });
});

describe("ask-mode memory injection (Message 6 repair)", () => {
  it("buildSystemPrompt includes memory content in ask mode", async () => {
    const { buildSystemPrompt } = await import("../master-prompt");
    await memoryWrite("/preferences.md", "docs style: concise with headings", "new", "user-A");
    const prompt = await buildSystemPrompt({
      mode: "ask",
      effort: "medium",
      capabilities: {},
      task: "What docs style do I prefer?",
      projectId: "user-A",
      userId: "user-A",
    });
    expect(prompt).toContain("concise with headings");
    expect(prompt).toContain("## Memory — preferences");
  });
});