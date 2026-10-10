// checkpoints.ts — LAYER 2 snapshots (durable-history snapshots, not a parallel system).
//
// History model (the only allowed end state):
//   Layer 1 (working/session): file-history.ts — in-memory + sessionStorage, undo + Changes tab.
//   Layer 2 (durable): workspace-history.ts — single append-only history.jsonl; every
//     mutation is recorded with enough data to restore.
//
// Checkpoints are snapshots OF Layer 2's world: a git tree-commit in
// refs/orplex/checkpoints/<runId>/<n> (or a file-copy snapshot for non-git
// workspaces) PLUS the durable-history offset at capture time (historyLength).
// Restore always records through the durable layer (one entry per restored
// file), so checkpoint restore is itself undoable via /api/agent/history.
//
// Two kinds, chosen per workspace:
//   git      — a tree-commit landed in refs/orplex/checkpoints/<runId>/<n>.
//              The working tree, branches, and tags are NEVER touched; the
//              commit is reachable only through the ref (delete the namespace
//              and it's gone — users own their history, we borrow it).
//   snapshot — plain file copies under .orplex/checkpoints/<runId>-<n>/ with
//              a manifest.json (paths + sha256). For non-git workspaces.
//
// Restore records an INVERSE snapshot first, so restore is itself undoable.
// Laptop budgets: ≤20/run, ≤25MB/run, per-file streamed hashing/copying.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { appendHistory, readHistory } from "./workspace-history";

export interface CheckpointFile {
  path: string;
  before: string | null; // sha256, null = created
  after: string | null;  // sha256, null = deleted
}

export interface CheckpointResult {
  id: string;          // "<runId>:<n>"
  n: number;
  kind: "git" | "snapshot";
  ref: string;         // git ref, or snapshot dir path
  label: string;
  files: CheckpointFile[];
  /** Durable-history (Layer 2) entry count at capture — the snapshot's offset into history.jsonl. */
  historyLength: number;
}

/** Current Layer-2 offset for a workspace root. -1 when unreadable (never throws). */
export async function layer2Offset(root: string): Promise<number> {
  try {
    return (await readHistory(root)).length;
  } catch {
    return -1;
  }
}

const MAX_PER_RUN = 20;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;

function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: root, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".cache", ".orplex-workspaces", ".orplex"]);

async function sha256File(p: string): Promise<string> {
  const buf = await readFile(p);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Diff the working tree against HEAD (git) into the file list. Untracked
 * files count as created; missing files as deleted.
 */
export async function workingTreeFiles(root: string): Promise<Array<{ path: string; status: string }>> {
  const out = await git(root, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  const files: Array<{ path: string; status: string }> = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith("R") || p.startsWith("C")) {
      // rename/copy entries carry the new path in the NEXT field — skip it.
      const status = p.slice(0, 2);
      const newPath = parts[i + 1] ?? "";
      i++;
      files.push({ path: newPath, status });
      continue;
    }
    files.push({ path: p.slice(3), status: p.slice(0, 2) });
  }
  return files.filter((f) => !f.path.split("/").some((seg) => SKIP_DIRS.has(seg)));
}

export async function nextSequence(root: string, runId: string): Promise<number> {
  const ns = `refs/orplex/checkpoints/${runId}`;
  try {
    const out = await git(root, ["for-each-ref", `--format=%(refname)`, ns]);
    return out.trim() ? out.trim().split("\n").length : 0;
  } catch {
    return 0;
  }
}

/**
 * Create a checkpoint of the current working tree (git kind).
 * Tree-commit: `git add -A` on a TEMP index only — the real index and
 * working tree are untouched; the commit hangs off the checkpoint ref.
 */
export async function createCheckpointGit(
  root: string,
  runId: string,
  label: string,
  files: CheckpointFile[]
): Promise<CheckpointResult> {
  const n = await nextSequence(root, runId);
  if (n >= MAX_PER_RUN) throw new Error(`checkpoint budget reached (${MAX_PER_RUN}/run)`);
  const tmpIdx = join(root, ".orplex", `checkpoint-index-${runId}`);
  await mkdir(dirname(tmpIdx), { recursive: true });
  const env = { ...process.env, GIT_INDEX_FILE: tmpIdx };
  const gitEnv = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile("git", args, { cwd: root, timeout: GIT_TIMEOUT_MS, windowsHide: true, env }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
  try {
    await gitEnv(["read-tree", "HEAD"]);
    await gitEnv(["add", "-A"]);
    const tree = (await gitEnv(["write-tree"])).trim();
    const parent = (await git(root, ["rev-parse", "HEAD"]).catch(() => "")).trim();
    const commitArgs = ["commit-tree", tree, "-m", `orplex checkpoint ${runId}/${n}: ${label}`];
    if (parent) commitArgs.push("-p", parent);
    const commit = (await git(root, commitArgs)).trim();
    const ref = `refs/orplex/checkpoints/${runId}/${n}`;
    await git(root, ["update-ref", ref, commit]);
    return { id: `${runId}:${n}`, n, kind: "git", ref, label, files, historyLength: await layer2Offset(root) };
  } finally {
    await rm(tmpIdx, { force: true }).catch(() => {});
  }
}

/**
 * Snapshot kind: copy changed files into .orplex/checkpoints/<runId>-<n>/.
 * `changed` maps workspace-relative path → absolute current path.
 */
export async function createCheckpointSnapshot(
  root: string,
  runId: string,
  label: string,
  changed: Array<{ path: string; abs: string; created: boolean }>,
  files: CheckpointFile[]
): Promise<CheckpointResult> {
  let n = 0;
  const base = join(root, ".orplex", "checkpoints");
  try {
    n = (await readdir(base)).filter((d) => d.startsWith(`${runId}-`)).length;
  } catch {
    n = 0;
  }
  if (n >= MAX_PER_RUN) throw new Error(`checkpoint budget reached (${MAX_PER_RUN}/run)`);
  const dir = join(base, `${runId}-${n}`);
  await mkdir(dir, { recursive: true });
  let bytes = 0;
  const manifest: Array<{ path: string; sha256: string | null }> = [];
  for (const f of changed) {
    if (f.created) continue; // nothing to copy for pre-existing files? (created=true means NEW file)
    const s = await stat(f.abs).catch(() => null);
    if (!s || !s.isFile()) continue;
    if (bytes + s.size > MAX_TOTAL_BYTES) break; // budget guard
    // Containment (defense in depth — callers gate too): the copy destination
    // must stay inside the snapshot dir.
    const dest = join(dir, f.path);
    const resolvedDest = resolve(dest);
    const resolvedDir = resolve(dir);
    if (resolvedDest !== resolvedDir && !resolvedDest.startsWith(resolvedDir + sep)) continue;
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(f.abs, dest);
    manifest.push({ path: f.path, sha256: await sha256File(dest) });
    bytes += s.size;
  }
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ runId, n, label, at: Date.now(), files, copied: manifest, historyLength: await layer2Offset(root) }, null, 1), "utf8");
  return { id: `${runId}:${n}`, n, kind: "snapshot", ref: dir, label, files, historyLength: await layer2Offset(root) };
}

/** List checkpoints for a run (git kind). */
export async function listCheckpointsGit(root: string, runId: string): Promise<Array<{ n: number; ref: string; label: string }>> {
  const ns = `refs/orplex/checkpoints/${runId}`;
  try {
    const out = await git(root, ["for-each-ref", `--format=%(refname) %(subject)`, ns]);
    return out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [refname, ...subj] = line.split(" ");
        const n = Number(refname.split("/").pop());
        return { n, ref: refname, label: subj.join(" ").replace(/^orplex checkpoint [^:]*: /, "") };
      })
      .sort((a, b) => a.n - b.n);
  } catch {
    return [];
  }
}

/** Snapshot-kind listing. */
export async function listCheckpointsSnapshot(root: string, runId: string): Promise<Array<{ n: number; ref: string; label: string }>> {
  const base = join(root, ".orplex", "checkpoints");
  try {
    const dirs = (await readdir(base)).filter((d) => d.startsWith(`${runId}-`));
    const out: Array<{ n: number; ref: string; label: string }> = [];
    for (const d of dirs) {
      try {
        const m = JSON.parse(await readFile(join(base, d, "manifest.json"), "utf8")) as { label?: string };
        out.push({ n: Number(d.split("-").pop()), ref: join(base, d), label: m.label ?? "" });
      } catch {
        /* skip corrupt */
      }
    }
    return out.sort((a, b) => a.n - b.n);
  } catch {
    return [];
  }
}

/**
 * Restore a git checkpoint: first record an inverse snapshot of the current
 * tree (so restore is undoable), then checkout the ref's tree into the
 * working tree — index and ref namespace stay intact.
 *
 * Layer-2 rule: every restored file is ALSO appended to the durable history
 * (prev = pre-restore content from the inverse commit, next = restored
 * content), so the restore itself can be undone via /api/agent/history.
 * History writes are best-effort per file — they never fail the restore.
 */
export async function restoreCheckpointGit(root: string, ref: string, runId: string): Promise<CheckpointResult> {
  // Inverse: snapshot what the tree looks like NOW.
  const status = await workingTreeFiles(root);
  const files: CheckpointFile[] = [];
  for (const f of status) {
    const abs = join(root, f.path);
    const s = await stat(abs).catch(() => null);
    files.push({
      path: f.path,
      before: s?.isFile() ? await sha256File(abs) : null,
      after: null, // filled by caller when it matters
    });
  }
  const inverse = await createCheckpointGit(root, `${runId}-restore-inverse`, `inverse of restore ${ref}`, files);
  await git(root, ["checkout", ref, "--", "."]);
  // Through the durable layer: prev from the inverse commit, next from disk.
  const restored = await git(root, ["ls-tree", "-r", "--name-only", ref]).catch(() => "");
  const touched = new Set([...files.map((f) => f.path), ...restored.split("\n").map((s) => s.trim()).filter(Boolean)]);
  let i = 0;
  for (const p of touched) {
    if (i++ >= 100) break; // cap: history is a safety net, not a full mirror
    try {
      const prev = await git(root, ["show", `${inverse.ref}:${p}`]).catch(() => null);
      const next = await readFile(join(root, p), "utf8").catch(() => null);
      if (next === null && prev === null) continue;
      await appendHistory(root, {
        path: p,
        prev: prev === null ? null : String(prev).slice(0, 200_000),
        next: next === null ? "" : String(next).slice(0, 200_000),
        peer: "restore",
      });
    } catch {
      /* per-file best-effort */
    }
  }
  return { id: `restore:${ref}`, n: -1, kind: "git", ref, label: "restore", files, historyLength: await layer2Offset(root) };
}

/** Convenience wrapper: create the right kind for this workspace. */
export async function createCheckpoint(
  root: string,
  runId: string,
  label: string,
  changed: Array<{ path: string; abs: string; created: boolean }>
): Promise<CheckpointResult> {  if (await isGitRepo(root)) {
    const wt = await workingTreeFiles(root);
    const files: CheckpointFile[] = [];
    for (const f of wt) {
      const abs = join(root, f.path);
      const s = await stat(abs).catch(() => null);
      files.push({
        path: f.path,
        before: f.status.includes("D") ? null : "HEAD",
        after: s?.isFile() ? await sha256File(abs) : null,
      });
    }
    return createCheckpointGit(root, runId, label, files);
  }
  const files: CheckpointFile[] = changed.map((c) => ({ path: c.path, before: null, after: null }));
  return createCheckpointSnapshot(root, runId, label, changed, files);
}

/**
 * snapshotLayer2 — the only allowed checkpoint constructor going forward.
 * Same mechanism as createCheckpoint (kept for its callers/tests); the alias
 * makes the Layer-2 framing explicit at new call sites.
 */
export const snapshotLayer2 = createCheckpoint;

export { MAX_PER_RUN, MAX_TOTAL_BYTES };
