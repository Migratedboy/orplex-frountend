// grep-search.ts — Real code search for the agent's search_code tool.
//
// The old search_code was a case-insensitive substring scan over the worker's
// bulk-read cache (120 files / 150KB) — blind to anything not previously read.
// This module searches the actual tree server-side, with a Windows-safe
// fallback chain (the author's machine is Windows without guaranteed rg):
//
//   1. ripgrep      — fastest, respects .gitignore, best regex support
//   2. git grep     — universally present in repos, respects .gitignore
//   3. Node scanner — git ls-files walk + regex, for non-repo dirs / no git
//
// All engines return the same line-oriented format: "path:line: text".
// Output is capped (bytes + match count) so a hot pattern can't flood a
// model prompt or a route response.

import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

const execFileAsync = promisify(execFile);

export const MAX_SEARCH_OUTPUT_BYTES = 50_000;
export const MAX_SEARCH_MATCHES = 200;
const SEARCH_TIMEOUT_MS = 8_000;
const MAX_FILE_SIZE_BYTES = 1_500_000;

export interface SearchResult {
  engine: "ripgrep" | "gitgrep" | "node";
  output: string;
  truncated: boolean;
  matchCount: number;
}

/** Validate + normalize the directory: absolute, existing, no null bytes. */
function resolveRoot(rootDir: string): string | null {
  if (!rootDir || rootDir.includes("\0")) return null;
  const resolved = path.resolve(rootDir);
  if (!path.isAbsolute(resolved)) return null;
  return resolved;
}

function capOutput(raw: string): { output: string; truncated: boolean; matchCount: number } {
  const lines = raw.split("\n").filter(Boolean);
  const matchCount = lines.length;
  let truncated = false;
  let outLines = lines;
  if (outLines.length > MAX_SEARCH_MATCHES) {
    outLines = outLines.slice(0, MAX_SEARCH_MATCHES);
    truncated = true;
  }
  let output = outLines.join("\n");
  if (Buffer.byteLength(output, "utf8") > MAX_SEARCH_OUTPUT_BYTES) {
    // Drop lines until under the byte cap
    const kept: string[] = [];
    let bytes = 0;
    for (const line of outLines) {
      const lineBytes = Buffer.byteLength(line + "\n", "utf8");
      if (bytes + lineBytes > MAX_SEARCH_OUTPUT_BYTES) {
        truncated = true;
        break;
      }
      kept.push(line);
      bytes += lineBytes;
    }
    output = kept.join("\n");
  }
  if (truncated) output += `\n…[search output capped at ${MAX_SEARCH_MATCHES} matches / ${MAX_SEARCH_OUTPUT_BYTES} bytes — refine the query]`;
  return { output, truncated, matchCount };
}

async function tryRipgrep(rootDir: string, pattern: string, isRegex: boolean): Promise<string | null> {
  try {
    const args = ["--line-number", "--no-heading", "--max-count", "5", "--color", "never"];
    if (!isRegex) args.push("--fixed-strings");
    args.push("-e", pattern, ".");
    const { stdout } = await execFileAsync("rg", args, {
      cwd: rootDir,
      timeout: SEARCH_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (err: unknown) {
    const e = err as { code?: string | number; message?: string };
    // rg exits 1 on "no matches" (valid empty result), anything else is a real failure
    if (e.code === 1) return "";
    return null; // rg not installed / failed → next engine
  }
}

async function tryGitGrep(rootDir: string, pattern: string, isRegex: boolean): Promise<string | null> {
  try {
    const args = ["grep", "-n", "-I", "--max-count", "5"];
    if (!isRegex) args.push("-F");
    args.push("-e", pattern);
    const { stdout } = await execFileAsync("git", args, {
      cwd: rootDir,
      timeout: SEARCH_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (err: unknown) {
    const e = err as { code?: string | number };
    if (e.code === 1) return ""; // no matches
    return null; // not a repo / git missing → next engine
  }
}

/**
 * Pure-Node fallback: walk git ls-files (or a bounded readdir when not a
 * repo), regex over file contents. Slower by orders of magnitude but always
 * available — this is what runs on a bare Windows box with no rg.
 */
const WALK_SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".docusaurus"]);

async function walkFiles(rootDir: string, maxFiles: number, maxDepth: number): Promise<string[]> {
  const fs = await import("fs/promises");
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          await walk(path.join(dir, entry.name), depth + 1);
        }
      } else if (entry.isFile()) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  await walk(rootDir, 0);
  return out;
}

async function nodeScan(rootDir: string, pattern: string, isRegex: boolean): Promise<string | null> {
  try {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "i");
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }

    // Prefer tracked files (respects .gitignore); fall back to a bounded walk.
    const rel = await execFileAsync("git", ["ls-files"], {
      cwd: rootDir,
      timeout: SEARCH_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    }).catch(() => null);
    let files: string[] = rel
      ? rel.stdout.split("\n").filter(Boolean)
      : (await walkFiles(rootDir, 2_000, 6)).map((abs) => path.relative(rootDir, abs));

    const results: string[] = [];
    let capped = false;
    for (const relPath of files) {
      if (results.length >= MAX_SEARCH_MATCHES) {
        // Hitting the cap means real matches were dropped downstream.
        capped = true;
        break;
      }
      const abs = path.join(rootDir, relPath);
      try {
        const fs = await import("fs/promises");
        const stat = await fs.stat(abs);
        if (stat.size > MAX_FILE_SIZE_BYTES) continue;
        const content = await fs.readFile(abs, "utf8");
        const lines = content.split("\n");
        let perFile = 0;
        for (let i = 0; i < lines.length && perFile < 5; i++) {
          if (results.length >= MAX_SEARCH_MATCHES) {
            capped = true;
            break;
          }
          if (regex.test(lines[i])) {
            results.push(`${relPath.replace(/\\/g, "/")}:${i + 1}: ${lines[i].slice(0, 300)}`);
            perFile++;
          }
        }
        if (capped) break;
      } catch {
        // unreadable / binary-as-utf8-garbage — skip
      }
    }
    if (capped) {
      return `${results.join("\n")}\n…[search output capped at ${MAX_SEARCH_MATCHES} matches — refine the query]`;
    }
    return results.join("\n");
  } catch {
    return null;
  }
}

/**
 * Search `rootDir` for `pattern`. Tries rg → git grep → node scan in order,
 * returning the first engine that produces a definitive result.
 * `isRegex: false` (the default) treats the pattern as a literal string.
 */
export async function grepSearch(
  rootDir: string,
  pattern: string,
  opts: { isRegex?: boolean } = {}
): Promise<SearchResult | null> {
  const root = resolveRoot(rootDir);
  if (!root || !pattern || pattern.length > 500) return null;
  const isRegex = opts.isRegex ?? false;

  const engines: Array<[SearchResult["engine"], () => Promise<string | null>]> = [
    ["ripgrep", () => tryRipgrep(root, pattern, isRegex)],
    ["gitgrep", () => tryGitGrep(root, pattern, isRegex)],
    ["node", () => nodeScan(root, pattern, isRegex)],
  ];

  for (const [engine, run] of engines) {
    const raw = await run();
    if (raw === null) continue; // engine unavailable — try the next
    const capped = capOutput(raw);
    return { engine, ...capped };
  }
  return null; // every engine failed to run at all
}
