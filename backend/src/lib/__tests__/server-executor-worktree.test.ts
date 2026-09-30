import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
const exec = promisify(execFile);

import {
  createIsolatedContext,
  type WorktreeContext,
} from "../server-executor/worktree";

jest.setTimeout(30_000);

async function git(cwd: string, args: string[]): Promise<string> {
  const res = await exec("git", args, { cwd });
  return res.stdout.trim();
}

async function makeGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orplex-wt-test-"));
  await git(dir, ["init", "-b", "main"]);
  await exec("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"], {}).catch(
    async () => {
      // older gits without -b support: init then branch
    }
  );
  await writeFile(join(dir, "README.md"), "# test\n");
  await git(dir, ["add", "-A"]);
  await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"], { cwd: dir });
  return dir;
}

describe("server-executor worktree isolation", () => {
  let dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
    dirs = [];
  });

  it("creates a worktree for git repos, isolates writes, merges back", async () => {
    const repo = await makeGitRepo();
    dirs.push(repo);

    const ctx: WorktreeContext = await createIsolatedContext(repo, "testrun123");
    dirs.push(ctx.worktreeDir);

    expect(ctx.isGitRepo).toBe(true);
    expect(ctx.baseBranch).toBe("main");
    // Worktree has the repo's files
    const exists = await writeFile(join(ctx.worktreeDir, "agent.txt"), "agent work\n");
    void exists;

    // Agent writes land in the worktree, NOT the user's repo
    const agentFile = join(ctx.worktreeDir, "agent.txt");
    await writeFile(agentFile, "agent work\n");
    const { existsSync } = await import("fs");
    expect(existsSync(join(repo, "agent.txt"))).toBe(false);

    // Commit + diff sees the change; repo is untouched
    const sha = await ctx.commit("agent change");
    expect(sha).toBeTruthy();
    const changed = await ctx.diffFiles();
    expect(changed).toContain("agent.txt");

    // Merge back brings the file into the user's repo
    const outcome = await ctx.mergeBack();
    expect(outcome.merged).toBe(true);
    expect(existsSync(join(repo, "agent.txt"))).toBe(true);

    await ctx.cleanup();
  });

  it("falls back to a directory copy for non-git folders", async () => {
    const plain = await mkdtemp(join(tmpdir(), "orplex-plain-"));
    dirs.push(plain);
    await writeFile(join(plain, "data.txt"), "hello\n");

    const ctx = await createIsolatedContext(plain, "testrun456");
    dirs.push(ctx.worktreeDir);

    expect(ctx.isGitRepo).toBe(false);
    expect(ctx.worktreeDir).not.toBe(plain);
    await writeFile(join(ctx.worktreeDir, "new.txt"), "x\n");
    const { existsSync } = await import("fs");
    expect(existsSync(join(plain, "new.txt"))).toBe(false);

    const outcome = await ctx.mergeBack();
    expect(outcome.merged).toBe(false); // honest: no merge path for non-git

    await ctx.cleanup();
  });

  it("refuses to merge into a dirty workspace without touching it", async () => {
    const repo = await makeGitRepo();
    dirs.push(repo);

    const ctx = await createIsolatedContext(repo, "testrun789");
    dirs.push(ctx.worktreeDir);
    await writeFile(join(ctx.worktreeDir, "feature.txt"), "work\n");
    await ctx.commit("agent change");

    // User edits a file (dirty tree) — merge must refuse
    await writeFile(join(repo, "README.md"), "# user edited\n");
    const outcome = await ctx.mergeBack();
    expect(outcome.merged).toBe(false);
    expect(outcome.conflict).toMatch(/uncommitted/i);

    await ctx.cleanup();
  });

  it("cleanup removes the worktree and branch", async () => {
    const repo = await makeGitRepo();
    dirs.push(repo);

    const ctx = await createIsolatedContext(repo, "testrunabc");
    dirs.push(ctx.worktreeDir);
    const { existsSync } = await import("fs");
    expect(existsSync(ctx.worktreeDir)).toBe(true);

    await ctx.cleanup();
    expect(existsSync(ctx.worktreeDir)).toBe(false);
    const branches = await git(repo, ["branch", "--list", `orplex/${ctx.id}`]);
    expect(branches).toBe("");
  });
});
