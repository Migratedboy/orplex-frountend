import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendHistory,
  appendKeepMarkers,
  getPendingHistoryChanges,
  readHistory,
} from "../workspace-history";

describe("pending workspace history", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orplex-pending-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the first snapshot across repeated edits and resets it at Keep", async () => {
    await appendHistory(root, { path: "src/a.ts", prev: "original", next: "first" });
    await appendHistory(root, { path: "src/a.ts", prev: "first", next: "latest" });
    await appendHistory(root, { path: "src/new.ts", prev: null, next: "new" });

    expect(getPendingHistoryChanges(await readHistory(root))).toEqual([
      { path: "src/a.ts", prev: "original", next: "latest", encoding: "utf8" },
      { path: "src/new.ts", prev: null, next: "new", encoding: "utf8" },
    ]);

    await appendKeepMarkers(root, ["src/a.ts"]);
    await appendHistory(root, { path: "src/a.ts", prev: "latest", next: "accepted then changed" });

    expect(getPendingHistoryChanges(await readHistory(root))).toEqual([
      { path: "src/new.ts", prev: null, next: "new", encoding: "utf8" },
      { path: "src/a.ts", prev: "latest", next: "accepted then changed", encoding: "utf8" },
    ]);
  });

  it("drops changes reverted to the original snapshot", async () => {
    await appendHistory(root, { path: "src/a.ts", prev: "original", next: "edited" });
    await appendHistory(root, { path: "src/a.ts", prev: "edited", next: "original" });
    expect(getPendingHistoryChanges(await readHistory(root))).toEqual([]);
  });

  it("preserves empty-file snapshots and rejects snapshots it cannot store exactly", async () => {
    expect(await appendHistory(root, { path: "empty.txt", prev: "", next: "content" })).toBe(true);
    expect(await appendHistory(root, {
      path: "too-large.txt",
      prev: null,
      // Over the durable snapshot cap (32M chars ≈ 24MB binary / 43MB base64):
      // appends beyond it would create un-undoable changes, so they are refused.
      next: "x".repeat(32_000_001),
    })).toBe(false);
    expect(getPendingHistoryChanges(await readHistory(root))).toEqual([
      { path: "empty.txt", prev: "", next: "content", encoding: "utf8" },
    ]);
  });

  it("retains the first snapshot even after the history exceeds its read window", async () => {
    await appendHistory(root, { path: "src/a.ts", prev: "original", next: "first" });
    for (let i = 0; i < 250; i++) {
      await appendHistory(root, { path: `other-${i}.txt`, prev: "a", next: "b" });
    }
    await appendHistory(root, { path: "src/a.ts", prev: "first", next: "latest" });
    const pending = getPendingHistoryChanges(await readHistory(root));
    expect(pending.find((change) => change.path === "src/a.ts")).toEqual({
      path: "src/a.ts", prev: "original", next: "latest", encoding: "utf8",
    });
  });
});
