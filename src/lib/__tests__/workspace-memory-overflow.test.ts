// workspace-memory-overflow.test.ts — Phase 6: pinned facts must survive the
// per-workspace LRU cap. Retrieval honours pins (they outrank statistics and
// skip stale-eviction) but the overflow branch used to delete the tail rows
// blindly — a /remember fact could be evicted past 250 while the prompt kept
// promising it. These tests lock the fix: overflow skips pinned rows, evicts
// the next unpinned entry instead, and grows the cap when everything is pinned.

const mockRows: Array<{ id: string; evidence: unknown }> = [];
const deletedIds: string[][] = [];

jest.mock("../prisma", () => ({
  prisma: {
    workspaceMemory: {
      findMany: jest.fn(async () => mockRows),
      upsert: jest.fn(async () => ({})),
      deleteMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        deletedIds.push([...where.id.in]);
        return { count: where.id.in.length };
      }),
    },
  },
}));

import {
  captureWorkspaceMemories,
  isPinnedEvidence,
  selectOverflowVictims,
} from "../workspace-memory";
import { prisma } from "../prisma";

const CAP = 250; // MAX_ENTRIES_PER_WORKSPACE

beforeEach(() => {
  mockRows.length = 0;
  deletedIds.length = 0;
  (prisma.workspaceMemory.findMany as jest.Mock).mockClear();
  (prisma.workspaceMemory.deleteMany as jest.Mock).mockClear();
  (prisma.workspaceMemory.upsert as jest.Mock).mockClear();
});

function row(id: string, pinned: boolean, ageMs: number) {
  return {
    id,
    evidence: pinned ? { pinned: true, source: "user" } : { task: "t" },
    lastSeenAt: new Date(Date.now() - ageMs),
  };
}

describe("selectOverflowVictims — pins are eviction-proof", () => {
  it("evicts LRU unpinned rows only and reports the unchanged cap", () => {
    // 252 rows (overflow 2): the two LRU rows are unpinned.
    const rows = [
      ...Array.from({ length: CAP }, (_, i) => row(`new-${i}`, false, i)),
      row("old-1", false, 900_000),
      row("old-2", false, 999_999),
    ];
    const { victimIds, effectiveCap } = selectOverflowVictims(rows, CAP);
    expect(victimIds).toEqual(["old-2", "old-1"]); // pure LRU order
    expect(effectiveCap).toBe(CAP);
  });

  it("never picks a pinned row — it skips to the next unpinned entry instead", () => {
    // The LRU tail is a pinned /remember fact followed by one unpinned row.
    const rows = [
      ...Array.from({ length: CAP }, (_, i) => row(`new-${i}`, false, i)),
      row("pinned-fact", true, 999_998),
      row("old-unpinned", false, 999_999),
    ];
    const { victimIds, effectiveCap } = selectOverflowVictims(rows, CAP);
    // Tail-first LRU walk (same order convention as the first test): the
    // unpinned LRU row, then — the pin being skipped — newest in-cap row.
    // Overflow is 2 here (the pin is NOT a victim), so the cap is still met.
    expect(victimIds).toEqual(["old-unpinned", "new-249"]);
    expect(victimIds).not.toContain("pinned-fact");
    expect(victimIds.every((id) => id !== "pinned-fact")).toBe(true);
    expect(effectiveCap).toBe(CAP); // still able to satisfy the overflow
  });

  it("evicts an in-cap unpinned row when every overflow row is pinned", () => {
    // Overflow = 3, but all 3 LRU rows are pinned: the cap is honoured by
    // taking the least-recently-seen UNPINNED row further up instead.
    const rows = [
      ...Array.from({ length: CAP - 3 }, (_, i) => row(`new-${i}`, false, i)),
      row("p1", true, 900_000),
      row("p2", true, 900_001),
      row("p3", true, 900_002),
      row("u1", false, 900_003),
      row("u2", false, 900_004),
      row("u3", false, 900_005),
    ];
    const { victimIds, effectiveCap } = selectOverflowVictims(rows, CAP);
    // Tail-first LRU walk, most-LRU victim first (convention from test 1).
    expect(victimIds).toEqual(["u3", "u2", "u1"]); // LRU unpinned of the tail
    expect(victimIds.some((id) => id.startsWith("p"))).toBe(false);
    expect(effectiveCap).toBe(CAP);
  });

  it("grows the cap rather than delete a pin when EVERY entry is pinned", () => {
    const rows = Array.from({ length: CAP + 5 }, (_, i) => row(`pin-${i}`, true, i));
    const { victimIds, effectiveCap } = selectOverflowVictims(rows, CAP);
    expect(victimIds).toEqual([]);
    expect(effectiveCap).toBe(CAP + 5); // cap grows; nothing pinned is lost
  });

  it("evicts nothing at or below the cap", () => {
    const rows = Array.from({ length: CAP }, (_, i) => row(`r-${i}`, i === 0, i));
    expect(selectOverflowVictims(rows, CAP)).toEqual({ victimIds: [], effectiveCap: CAP });
  });

  it("isPinnedEvidence reads only an explicit pinned flag", () => {
    expect(isPinnedEvidence({ pinned: true })).toBe(true);
    expect(isPinnedEvidence({ pinned: false })).toBe(false);
    expect(isPinnedEvidence({})).toBe(false);
    expect(isPinnedEvidence(null)).toBe(false);
    expect(isPinnedEvidence("pinned")).toBe(false);
  });
});

describe("captureWorkspaceMemories — the overflow branch never deletes a pin", () => {
  it("a pinned fact survives an overflow past the 250 cap", async () => {
    // 260 rows: the LRU tail holds one pinned fact and one unpinned row.
    const pinnedRow = row("pinned-survivor", true, 10 * 60_000);
    const unpinnedLRU = row("evict-me", false, 11 * 60_000);
    mockRows.push(
      ...Array.from({ length: 258 }, (_, i) => row(`recent-${i}`, false, i)),
      pinnedRow,
      unpinnedLRU
    );

    const stored = await captureWorkspaceMemories({
      workspaceKey: "test-ws",
      task: "Build a Next.js settings page",
      writtenFiles: { "app/page.tsx": 'import Link from "next/link";' },
      lanes: { typecheck: "pass" },
      finalStatus: "done",
    });

    expect(stored).toBeGreaterThan(0);
    // The cap enforced (260 → 250) by deleting exactly the 10 LRU unpinned rows.
    expect(deletedIds).toHaveLength(1);
    const victims = deletedIds[0];
    expect(victims).toHaveLength(10);
    expect(victims).toContain("evict-me");
    expect(victims).not.toContain("pinned-survivor");
    // And findMany really did feed the victim picker every row (no blind skip).
    const findArgs = (prisma.workspaceMemory.findMany as jest.Mock).mock.calls[0][0];
    expect(findArgs.orderBy).toEqual({ lastSeenAt: "desc" });
    expect(findArgs.select).toEqual({ id: true, evidence: true });
    expect(findArgs.skip).toBeUndefined();
  });

  it("deletes nothing when every entry is pinned (cap grows instead)", async () => {
    mockRows.push(...Array.from({ length: CAP + 5 }, (_, i) => row(`pin-${i}`, true, i)));

    await captureWorkspaceMemories({
      workspaceKey: "test-ws",
      task: "remember everything",
      writtenFiles: { "a.ts": 'import "react";' },
      lanes: {},
      finalStatus: "done",
    });

    expect(deletedIds).toHaveLength(0); // no deleteMany with ids → none recorded
  });
});
