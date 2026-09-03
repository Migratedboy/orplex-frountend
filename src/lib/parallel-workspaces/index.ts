/**
 * parallel-workspaces/index.ts
 *
 * Antigravity-style parallel workspace system:
 * - Each agent task gets its own git worktree (or directory copy)
 * - Isolated file changes — no conflicts between agents
 * - Results merge back after approval
 */

import { execSync, spawn } from "child_process";
import { mkdir, cp, rm, writeFile, readFile, readdir, stat } from "fs/promises";
import { join, basename } from "path";
import { randomBytes } from "crypto";

// === Types ===

export interface Workspace {
  id: string;
  /** Original project root */
  rootDir: string;
  /** Isolated workspace directory */
  workspaceDir: string;
  /** Git branch name (if using worktrees) */
  branchName?: string;
  /** Creation timestamp */
  createdAt: Date;
  /** Associated agent run ID */
  runId?: string;
}

export interface MergeResult {
  success: boolean;
  filesChanged: string[];
  conflicts: string[];
  error?: string;
}

// === Workspace Management ===

const workspaces = new Map<string, Workspace>();

/**
 * Create a new isolated workspace for an agent task.
 * Uses git worktree if the project is a git repo,
 * otherwise copies the project directory.
 */
export async function createWorkspace(
  rootDir: string,
  runId?: string,
  agentRole?: string
): Promise<Workspace> {
  const id = `ws-${randomBytes(6).toString("hex")}`;
  const suffix = agentRole ? `-${agentRole}` : "";
  const branchName = `agent/${id}${suffix}`;

  // Check if git repo
  let isGitRepo = false;
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd: rootDir,
      stdio: "pipe",
      timeout: 5000,
    });
    isGitRepo = true;
  } catch {}

  if (isGitRepo) {
    return createGitWorktree(rootDir, id, branchName, runId);
  } else {
    return createDirectoryCopy(rootDir, id, runId);
  }
}

/**
 * Create an isolated workspace using git worktree
 */
async function createGitWorktree(
  rootDir: string,
  id: string,
  branchName: string,
  runId?: string
): Promise<Workspace> {
  const workspaceDir = join(rootDir, ".orplex-workspaces", id);

  try {
    // Create the worktree directory
    execSync(`mkdir -p "${join(rootDir, ".orplex-workspaces")}"`, {
      cwd: rootDir,
      stdio: "pipe",
    });

    // Create branch if it doesn't exist
    try {
      execSync(`git branch "${branchName}"`, {
        cwd: rootDir,
        stdio: "pipe",
        timeout: 10000,
      });
    } catch {
      // Branch might already exist — that's fine
    }

    // Create worktree
    execSync(
      `git worktree add "${workspaceDir}" "${branchName}" --detach`,
      {
        cwd: rootDir,
        stdio: "pipe",
        timeout: 30000,
      }
    );

    const workspace: Workspace = {
      id,
      rootDir,
      workspaceDir,
      branchName,
      createdAt: new Date(),
      runId,
    };

    workspaces.set(id, workspace);
    return workspace;
  } catch (err) {
    // Fallback to directory copy if worktree fails
    console.warn(
      `[Workspace] Git worktree failed, falling back to directory copy: ${(err as Error).message}`
    );
    return createDirectoryCopy(rootDir, id, runId);
  }
}

/**
 * Create an isolated workspace by copying the directory
 */
async function createDirectoryCopy(
  rootDir: string,
  id: string,
  runId?: string
): Promise<Workspace> {
  const workspaceDir = join(rootDir, ".orplex-workspaces", id);
  await mkdir(workspaceDir, { recursive: true });

  // Copy project files (excluding node_modules, .git, dist, etc.)
  const excludePatterns = [
    "node_modules",
    ".git",
    "dist",
    ".next",
    ".orplex-workspaces",
    ".orplex-verify",
    ".orplex-video",
  ];

  await copyDirRecursive(rootDir, workspaceDir, excludePatterns);

  const workspace: Workspace = {
    id,
    rootDir,
    workspaceDir,
    createdAt: new Date(),
    runId,
  };

  workspaces.set(id, workspace);
  return workspace;
}

/**
 * Recursive directory copy with exclusions
 */
async function copyDirRecursive(
  src: string,
  dest: string,
  excludes: string[]
): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    if (excludes.includes(entry.name)) continue;
    if (entry.name.startsWith(".")) continue; // Skip hidden dirs

    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      await mkdir(destPath, { recursive: true });
      await copyDirRecursive(srcPath, destPath, excludes);
    } else {
      await cp(srcPath, destPath, { recursive: true });
    }
  }
}

/**
 * Get a workspace by ID
 */
export function getWorkspace(id: string): Workspace | undefined {
  return workspaces.get(id);
}

/**
 * List all active workspaces
 */
export function listWorkspaces(): Workspace[] {
  return Array.from(workspaces.values());
}

/**
 * Get workspace file tree
 */
export async function getWorkspaceFiles(
  workspaceId: string
): Promise<string[]> {
  const ws = workspaces.get(workspaceId);
  if (!ws) return [];

  const files: string[] = [];
  await collectFiles(ws.workspaceDir, ws.workspaceDir, files);
  return files;
}

async function collectFiles(
  dir: string,
  root: string,
  files: string[]
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(dir, entry.name);
    const relativePath = fullPath.slice(root.length + 1);
    if (entry.isDirectory()) {
      await collectFiles(fullPath, root, files);
    } else {
      files.push(relativePath);
    }
  }
}

/**
 * Read a file from a workspace
 */
export async function readWorkspaceFile(
  workspaceId: string,
  filePath: string
): Promise<string | null> {
  const ws = workspaces.get(workspaceId);
  if (!ws) return null;

  try {
    return await readFile(join(ws.workspaceDir, filePath), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Write a file to a workspace
 */
export async function writeWorkspaceFile(
  workspaceId: string,
  filePath: string,
  content: string
): Promise<boolean> {
  const ws = workspaces.get(workspaceId);
  if (!ws) return false;

  try {
    const fullPath = join(ws.workspaceDir, filePath);
    const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, content, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Get file stats from a workspace
 */
export async function getWorkspaceFileStats(
  workspaceId: string
): Promise<
  Array<{
    path: string;
    size: number;
    modified: Date;
  }>
> {
  const ws = workspaces.get(workspaceId);
  if (!ws) return [];

  const files = await getWorkspaceFiles(workspaceId);
  const stats: Array<{ path: string; size: number; modified: Date }> = [];

  for (const file of files) {
    try {
      const s = await stat(join(ws.workspaceDir, file));
      stats.push({
        path: file,
        size: s.size,
        modified: s.mtime,
      });
    } catch {}
  }

  return stats;
}

/**
 * Merge workspace changes back to root directory
 * Creates a diff of changes for review before applying
 */
export async function prepareMerge(
  workspaceId: string
): Promise<MergeResult> {
  const ws = workspaces.get(workspaceId);
  if (!ws) {
    return {
      success: false,
      filesChanged: [],
      conflicts: [],
      error: "Workspace not found",
    };
  }

  try {
    // If git worktree, create a diff
    if (ws.branchName) {
      try {
        const diff = execSync(
          `git diff "${ws.branchName}" --stat`,
          { cwd: ws.rootDir, stdio: "pipe", timeout: 10000 }
        ).toString();

        const filesChanged = diff
          .split("\n")
          .filter((line) => line.includes("|"))
          .map((line) => line.split("|")[0].trim())
          .filter(Boolean);

        return {
          success: true,
          filesChanged,
          conflicts: [],
        };
      } catch {
        // If git diff fails, fall through to file comparison
      }
    }

    // For directory copies: compare files
    const wsFiles = await getWorkspaceFiles(workspaceId);
    const filesChanged: string[] = [];

    for (const file of wsFiles) {
      try {
        const wsContent = await readWorkspaceFile(workspaceId, file);
        let rootContent: string | null = null;
        try {
          rootContent = await readFile(join(ws.rootDir, file), "utf-8");
        } catch {}

        if (wsContent !== rootContent) {
          filesChanged.push(file);
        }
      } catch {}
    }

    return {
      success: true,
      filesChanged,
      conflicts: [],
    };
  } catch (err) {
    return {
      success: false,
      filesChanged: [],
      conflicts: [],
      error: (err as Error).message,
    };
  }
}

/**
 * Apply merged changes from workspace to root directory
 */
export async function applyMerge(
  workspaceId: string,
  filesToApply?: string[]
): Promise<MergeResult> {
  const ws = workspaces.get(workspaceId);
  if (!ws) {
    return {
      success: false,
      filesChanged: [],
      conflicts: [],
      error: "Workspace not found",
    };
  }

  try {
    const mergeResult = await prepareMerge(workspaceId);
    const files = filesToApply || mergeResult.filesChanged;

    const applied: string[] = [];
    const conflicts: string[] = [];

    for (const file of files) {
      try {
        const content = await readWorkspaceFile(workspaceId, file);
        if (content !== null) {
          const fullPath = join(ws.rootDir, file);
          const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
          await mkdir(dir, { recursive: true });
          await writeFile(fullPath, content, "utf-8");
          applied.push(file);
        }
      } catch {
        conflicts.push(file);
      }
    }

    return {
      success: conflicts.length === 0,
      filesChanged: applied,
      conflicts,
    };
  } catch (err) {
    return {
      success: false,
      filesChanged: [],
      conflicts: [],
      error: (err as Error).message,
    };
  }
}

/**
 * Destroy a workspace and clean up
 */
export async function destroyWorkspace(
  workspaceId: string
): Promise<boolean> {
  const ws = workspaces.get(workspaceId);
  if (!ws) return false;

  try {
    // Remove git worktree if applicable
    if (ws.branchName) {
      try {
        execSync(
          `git worktree remove "${ws.workspaceDir}" --force`,
          { cwd: ws.rootDir, stdio: "pipe", timeout: 15000 }
        );
      } catch {}
    }

    // Remove directory
    await rm(ws.workspaceDir, { recursive: true, force: true });

    workspaces.delete(workspaceId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get diff between workspace and root for a specific file
 */
export async function getFileDiff(
  workspaceId: string,
  filePath: string
): Promise<string | null> {
  const ws = workspaces.get(workspaceId);
  if (!ws) return null;

  try {
    const wsContent = await readWorkspaceFile(workspaceId, filePath);
    let rootContent: string | null = null;
    try {
      rootContent = await readFile(join(ws.rootDir, filePath), "utf-8");
    } catch {}

    if (wsContent === rootContent) return null;
    if (wsContent === null || rootContent === null) return null;

    // Simple line-by-line diff
    const wsLines = wsContent.split("\n");
    const rootLines = rootContent.split("\n");
    const diff: string[] = [];

    const maxLen = Math.max(wsLines.length, rootLines.length);
    for (let i = 0; i < maxLen; i++) {
      const wsLine = wsLines[i];
      const rootLine = rootLines[i];

      if (wsLine !== rootLine) {
        if (rootLine !== undefined) diff.push(`-${rootLine}`);
        if (wsLine !== undefined) diff.push(`+${wsLine}`);
      }
    }

    return diff.length > 0 ? diff.join("\n") : null;
  } catch {
    return null;
  }
}
