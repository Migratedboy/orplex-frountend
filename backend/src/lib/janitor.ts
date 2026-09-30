// janitor.ts — Whitelist-only cleanup of re-creatable artifacts.
//
// Scope guard: this module exists because a RAM-pressure sweep must NEVER be
// able to delete user data. The candidate set is a hardcoded whitelist of
// re-creatable caches/logs/orphans; a protected-path check runs against every
// candidate AFTER resolution, and anything protected (or anything that even
// *resolves into* a protected root) is skipped with a reason. User source,
// backups, .env, .git, DB data, vendored binaries — untouchable by
// construction, not by convention.
//
// Honest scope note: orphaned worktrees live in os.tmpdir()/orplex-worktrees
// (OUTSIDE the project root), so they are swept via an explicit single
// allowlist exception — that exact directory, entries older than 24h only
// (a live run's worktree is minutes old). Nothing else outside the root is
// ever considered.

import { readdir, rm, stat } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve, relative, isAbsolute } from "path";
import { tmpdir as osTmpdir } from "os";
import { recordRuntimeLog } from "./runtime-log";
import { runtimeState } from "./runtime-state";

const ROOT = process.cwd();

/**
 * Directories whose CONTENTS may be deleted (all re-creatable).
 *
 * .next/dev is DELIBERATELY ABSENT: it holds Turbopack's live task database
 * and is written DURING server startup, so even a boot-window sweep races
 * the server's own initialization (observed live: deleted routes-manifest
 * + turbopack SST chunks mid-boot → hard crash). Only an OUT-OF-PROCESS
 * cleanup with the server stopped can touch it — that's `npm run clean`.
 */
const CACHE_DIRS = [
  { dir: ".next/cache", bootOnly: false },
  { dir: join("node_modules", ".cache"), bootOnly: false },
  { dir: join("docs-site", ".docusaurus"), bootOnly: false },
  { dir: join("docs-site", "build"), bootOnly: false },
];

/** Named logs deleted only when larger than LOG_TRUNCATE_MB. */
const LOG_FILES = [join(".localpg", "dev.log"), join(".localpg", "runner.log")];
const LOG_TRUNCATE_MB = 25;

/** Orphan threshold for tmp worktrees (a live run's worktree is minutes old). */
const WORKTREE_ORPHAN_MS = 24 * 60 * 60 * 1000;

/** Protected paths (relative, posix-normalized). A candidate under any of these is skipped. */
const PROTECTED = [
  "backups",
  ".git",
  ".env",
  ".env.local",
  ".localpg",
  "prisma",
  "src",
  "public",
  "docs-site/src",
  "docs-site/docs",
  "electron",
  "vscode-extension",
  "scripts",
  "tools",
  "e2e",
  ".orplex-workspaces",
  ".orplex",
];

/** True if relPosix is protected (exact or nested). */
export function isProtectedPath(relPosix: string): boolean {
  const norm = relPosix.replace(/\\/g, "/");
  if (norm === ".env" || norm === ".env.local" || norm === ".git" || norm === "backups") return true;
  return PROTECTED.some((p) => norm === p || norm.startsWith(p + "/"));
}

/** Refuse anything that resolves outside the project root or into a protected path. */
function isAllowedCandidate(absPath: string): boolean {
  const rel = relative(ROOT, resolve(absPath));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false; // outside root → refuse
  return !isProtectedPath(rel);
}

export interface JanitorCandidate {
  path: string;
  kind: "cache" | "log" | "orphan-worktree";
  sizeBytes: number;
  reason: string;
}

export interface JanitorResult {
  candidates: number;
  deleted: number;
  bytesFreed: number;
  skipped: string[];
}

/**
 * Size of a file or directory tree (best-effort; errors count as 0).
 * Traversal is BUDGETED (max 1500 entries walked): under memory pressure a
 * full recursive walk of .next/cache or the docs build would itself be the
 * slowest thing on the machine. Overshoots report a conservative estimate.
 */
const SIZE_WALK_BUDGET = 1_500;

async function sizeOf(p: string, budget: { left: number } = { left: SIZE_WALK_BUDGET }): Promise<number> {
  try {
    if (budget.left <= 0) return 0;
    const st = await stat(p);
    if (st.isFile()) {
      budget.left -= 1;
      return st.size;
    }
    if (!st.isDirectory()) return 0;
    const entries = await readdir(p, { withFileTypes: true }).catch(() => []);
    let total = 0;
    for (const e of entries) {
      if (budget.left <= 0) break;
      total += await sizeOf(join(p, e.name), budget);
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * List every deletable candidate. `sizes: false` (critical pressure) skips
 * the size walk entirely — deletion speed matters more than reporting bytes.
 * Never deletes anything.
 */
export async function listSweepCandidates(opts: { sizes?: boolean } = {}): Promise<JanitorCandidate[]> {
  const wantSizes = opts.sizes !== false;
  const out: JanitorCandidate[] = [];

  for (const { dir } of CACHE_DIRS) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    if (!isAllowedCandidate(abs)) {
      out.push({ path: dir, kind: "cache", sizeBytes: 0, reason: "protected — skipped by denylist" });
      continue;
    }
    out.push({ path: dir, kind: "cache", sizeBytes: wantSizes ? await sizeOf(abs) : 0, reason: wantSizes ? "re-creatable cache" : "re-creatable cache (size not measured — critical mode)" });
  }

  for (const name of LOG_FILES) {
    const abs = join(ROOT, name);
    if (!existsSync(abs)) continue;
    const st = await stat(abs).catch(() => null);
    if (!st) continue;
    if (st.size > LOG_TRUNCATE_MB * 1024 * 1024) {
      out.push({ path: name, kind: "log", sizeBytes: st.size, reason: `log larger than ${LOG_TRUNCATE_MB} MB (recreated on next boot)` });
    }
  }

  // Orphaned executor worktrees — the ONE outside-root allowlist exception.
  const wtRoot = join(osTmpdir(), "orplex-worktrees");
  try {
    const entries = await readdir(wtRoot, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const abs = join(wtRoot, e.name);
      const st = await stat(abs).catch(() => null);
      if (!st) continue;
      if (Date.now() - st.mtimeMs < WORKTREE_ORPHAN_MS) continue; // possibly live
      out.push({ path: abs, kind: "orphan-worktree", sizeBytes: wantSizes ? await sizeOf(abs) : 0, reason: `worktree idle >24h (mtime ${st.mtime.toISOString()})` });
    }
  } catch {
    // no worktree dir — nothing to do
  }

  return out;
}

/**
 * Execute a sweep. "full" = caches + oversized logs + orphans (manual button,
 * boot when ORPLEX_JANITOR=1); "critical" = caches + orphans only, fired by
 * the RAM watchdog regardless of the auto-mode flag. Whitelist + denylist
 * checks run on every delete, not just on listing.
 */
export async function runJanitor(opts: { mode: "full" | "critical" }): Promise<JanitorResult> {
  if (runtimeState.janitor.running) {
    return { candidates: 0, deleted: 0, bytesFreed: 0, skipped: ["sweep already running"] };
  }
  runtimeState.janitor.running = true;
  const result: JanitorResult = { candidates: 0, deleted: 0, bytesFreed: 0, skipped: [] };
  try {
    const candidates = await listSweepCandidates({ sizes: opts.mode !== "critical" });
    result.candidates = candidates.length;

    for (const c of candidates) {
      if (c.reason.includes("skipped")) {
        result.skipped.push(`${c.path}: ${c.reason}`);
        continue;
      }
      if (opts.mode === "critical" && c.kind === "log") continue; // critical: RAM matters, logs can wait

      // Re-verify every delete target against the denylist at execution time.
      if (c.kind !== "orphan-worktree" && !isAllowedCandidate(join(ROOT, c.path))) {
        result.skipped.push(`${c.path}: protected — refused at delete time`);
        continue;
      }
      try {
        const abs = c.kind === "orphan-worktree" ? resolve(c.path) : join(ROOT, c.path);
        if (c.kind === "orphan-worktree") {
          const parent = resolve(join(osTmpdir(), "orplex-worktrees"));
          const resolved = resolve(abs);
          if (!resolved.startsWith(parent)) {
            result.skipped.push(`${c.path}: outside the sanctioned worktree root`);
            continue;
          }
          const st = await stat(resolved).catch(() => null);
          if (!st?.isDirectory() || Date.now() - st.mtimeMs < WORKTREE_ORPHAN_MS) {
            result.skipped.push(`${c.path}: no longer idle — skipped`);
            continue;
          }
        }
        await rm(abs, { recursive: true, force: true });
        result.deleted += 1;
        result.bytesFreed += c.sizeBytes;
      } catch {
        result.skipped.push(`${c.path}: delete failed (in use?)`);
      }
    }

    runtimeState.janitor.lastSweepAt = new Date().toISOString();
    runtimeState.janitor.lastResult = result;
    const mb = (result.bytesFreed / 1024 / 1024).toFixed(1);
    recordRuntimeLog("janitor", result.deleted > 0 ? "info" : "warn", `sweep (${opts.mode}): ${result.deleted}/${result.candidates} removed, ${mb} MB freed${result.skipped.length ? `, ${result.skipped.length} skipped` : ""}`);
    console.log(`[janitor] sweep (${opts.mode}): ${result.deleted}/${result.candidates} removed, ${mb} MB freed`);
    return result;
  } finally {
    runtimeState.janitor.running = false;
  }
}

/** Snapshot for the admin System page / API. */
export function getJanitorStatus() {
  return { ...runtimeState.janitor };
}
