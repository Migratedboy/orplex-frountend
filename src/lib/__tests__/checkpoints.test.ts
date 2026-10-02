// checkpoints.test.ts — The durable checkpoint engine: git tree-commits in
// the orplex ref namespace (working tree untouched), snapshot fallback,
// budget caps, restore roundtrip. Server-side history quota lives here too.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCheckpoint,
  isGitRepo,
  listCheckpointsGit,
  restoreCheckpointGit,
  workingTreeFiles,
  MAX_PER_RUN,
} from "../checkpoints";
import {
  appendHistory,
  readHistory,
  findUndoTarget,
  inverseOf,
  parseEntries,
  MAX_ENTRIES,
} from "../workspace-history";

function gitP(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: root, timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orplex-ckpt-"));
  await mkdir(join(dir, ".orplex"), { recursive: true });
}, 20_000);

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}, 20_000);

describe("checkpoints — git kind", () => {
  it("creates a ref checkpoint without touching the working tree", async () => {
    await gitP(dir, ["init"]);
    await gitP(dir, ["config", "user.email", "t@t"]);
    await gitP(dir, ["config", "user.name", "t"]);
    await writeFile(join(dir, "a.txt"), "hello");
    await gitP(dir, ["add", "."]);
    await gitP(dir, ["commit", "-m", "init"]);

    await writeFile(join(dir, "b.txt"), "new file");
    const cp = await createCheckpoint(dir, "run1", "test", []);
    expect(cp.kind).toBe("git");
    expect(cp.n).toBe(0);
    // Working tree still has the untracked file (untouched by checkpointing)
    const wt = await workingTreeFiles(dir);
    expect(wt.some((f) => f.path === "b.txt")).toBe(true);
    // Ref exists and its tree CONTAINS b.txt (checkpoint captured the tree)
    const listed = await listCheckpointsGit(dir, "run1");
    expect(listed).toHaveLength(1);
    expect(listed[0].label).toContain("test");
    const treeHasB = await gitP(dir, ["ls-tree", "-r", "--name-only", listed[0].ref]);
    expect(treeHasB).toContain("b.txt");
  }, 30_000);

  it("restores a checkpoint (file deletion rolled back), and restore is undoable", async () => {
    await gitP(dir, ["init"]);
    await gitP(dir, ["config", "user.email", "t@t"]);
    await gitP(dir, ["config", "user.name", "t"]);
    await writeFile(join(dir, "keep.txt"), "v1");
    await gitP(dir, ["add", "."]);
    await gitP(dir, ["commit", "-m", "init"]);

    await writeFile(join(dir, "keep.txt"), "v2 — agent edit");
    const cp = await createCheckpoint(dir, "run1", "after edit", []);
    expect(cp.kind).toBe("git");

    // Agent deletes the file after the checkpoint
    await rm(join(dir, "keep.txt"));
    expect(await readFile(join(dir, "keep.txt"), "utf8").catch(() => "GONE")).toBe("GONE");

    await restoreCheckpointGit(dir, cp.ref, "run1");
    expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("v2 — agent edit");
    // The inverse snapshot became a checkpoint under the restore-inverse namespace
    const inverses = await listCheckpointsGit(dir, "run1-restore-inverse");
    expect(inverses.length).toBe(1);
  }, 30_000);
});

describe("checkpoints — snapshot kind (non-git)", () => {
  it("copies changed files + manifest without git", async () => {
    expect(await isGitRepo(dir)).toBe(false);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "app.ts"), "const x = 1;");
    const cp = await createCheckpoint(dir, "run2", "snap", [
      { path: "src/app.ts", abs: join(dir, "src", "app.ts"), created: false },
    ]);
    expect(cp.kind).toBe("snapshot");
    expect(cp.ref).toContain("run2-0");
    const manifest = JSON.parse(await readFile(join(cp.ref, "manifest.json"), "utf8"));
    expect(manifest.copied).toHaveLength(1);
    expect(manifest.copied[0].path).toBe("src/app.ts");
  }, 20_000);
});

describe("budgets", () => {
  it("MAX_PER_RUN is 20 (laptop budget)", () => {
    expect(MAX_PER_RUN).toBe(20);
  });
});

describe("workspace-history", () => {
  it("appends and reads back (quota drops oldest)", async () => {
    for (let i = 0; i < MAX_ENTRIES + 10; i++) {
      await appendHistory(dir, { path: `f${i}.txt`, prev: "a", next: "b" });
    }
    const entries = await readHistory(dir);
    expect(entries.length).toBe(MAX_ENTRIES);
    expect(entries[0].path).toBe(`f10.txt`); // oldest 10 dropped
    expect(entries[entries.length - 1].path).toBe(`f${MAX_ENTRIES + 9}.txt`);
  }, 20_000);

  it("skips torn lines (crash mid-append)", async () => {
    const { writeFile: wf, mkdir: md } = await import("node:fs/promises");
    await md(join(dir, ".orplex"), { recursive: true });
    await wf(join(dir, ".orplex", "history.jsonl"),
      JSON.stringify({ t: 1, path: "ok.txt", prev: null, next: "x", peer: "p" }) + "\n" +
      '{"t":2,"path":"to' + "\n" +
      JSON.stringify({ t: 3, path: "ok2.txt", prev: "a", next: "b", peer: "p" }) + "\n");
    const entries = parseEntries(await readFile(join(dir, ".orplex", "history.jsonl"), "utf8"));
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.path)).toEqual(["ok.txt", "ok2.txt"]);
  });

  it("findUndoTarget skips entries overwritten by a later write", async () => {
    const entries = [
      { t: 1, path: "f.txt", prev: "orig", next: "v1", peer: "a" },
      { t: 2, path: "f.txt", prev: "v1", next: "v2", peer: "a" },
    ];
    expect(findUndoTarget(entries, "f.txt", "v2")?.prev).toBe("v1");
    // Someone changed the file since v2 — the stale target must not match.
    expect(findUndoTarget(entries, "f.txt", "someone-else-wrote")).toBeNull();
    // Inverse entries are never undo targets themselves.
    const withInverse = [...entries, inverseOf(entries[1], "m")];
    expect(findUndoTarget(withInverse, "f.txt", "v1")?.undoOf).toBeUndefined();
  });
});
