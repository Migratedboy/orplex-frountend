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

// code_search (snippet mode): how much context to show around each match and
// how much total output one call may return. Snippets are the agent's
// "locate regions before reading" surface — the page hint tells it exactly
// which read_file offset/limit covers the match.
const SNIPPET_CONTEXT_LINES = 3;
const SNIPPET_MAX_MATCHES = 20;
const SNIPPET_MAX_OUTPUT_BYTES = 30_000;
const SNIPPET_TIMEOUT_MS = 12_000;

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

async function tryRipgrep(rootDir: string, pattern: string, isRegex: boolean, perFileLimit: number): Promise<string | null> {
  try {
    const args = ["--line-number", "--no-heading", "--max-count", String(perFileLimit), "--color", "never"];
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

async function tryGitGrep(rootDir: string, pattern: string, isRegex: boolean, perFileLimit: number): Promise<string | null> {
  try {
    const args = ["grep", "-n", "-I", "--max-count", String(perFileLimit)];
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

async function nodeScan(rootDir: string, pattern: string, isRegex: boolean, perFileLimit: number): Promise<string | null> {
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
        for (let i = 0; i < lines.length && perFile < perFileLimit; i++) {
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
 * code_search — ripgrep with context: returns matching line SNIPPETS with
 * surrounding context lines, grouped per file, each match annotated with a
 * ready-made `read_file path offset=N limit=M` hint so the agent can jump
 * straight to the region in one call. Grouped format keeps multi-match
 * files compact and mirrors how editors present results.
 *
 * Tries the same engine chain (rg → git grep → node scan); rg runs with
 * -C 3 for context, the fallbacks synthesize context from their line hits.
 */
export async function codeSearch(
  rootDir: string,
  pattern: string,
  opts: { isRegex?: boolean; context?: number } = {}
): Promise<SearchResult | null> {
  const root = resolveRoot(rootDir);
  if (!root || !pattern || pattern.length > 500) return null;
  const isRegex = opts.isRegex ?? false;
  const context = Math.max(0, Math.min(10, Math.floor(opts.context ?? SNIPPET_CONTEXT_LINES)));

  // 1. ripgrep with context flags (fast path)
  const rg = await tryRipgrepContext(root, pattern, isRegex, context);
  if (rg !== null) return formatSnippets(rg, pattern, "ripgrep");

  // 2. git grep → synthesize context from per-file reads. The snippet mode
  // needs the FULL per-file count (to print "## file (12 matches)"), so the
  // fallback engines use the snippet cap rather than the plain-search cap of
  // 5 — the grouped output is identical whichever engine is available.
  const plain = await grepSearch(root, pattern, { isRegex, perFileLimit: SNIPPET_MAX_MATCHES });
  if (plain) return formatSnippets(plain.output, pattern, plain.engine);
  return null;
}

async function tryRipgrepContext(root: string, pattern: string, isRegex: boolean, context: number): Promise<string | null> {
  try {
    const args = [
      "--line-number", "--no-heading", "--max-count", String(SNIPPET_MAX_MATCHES),
      "--color", "never", "--context", String(context),
    ];
    if (!isRegex) args.push("--fixed-strings");
    args.push("-e", pattern, ".");
    const { stdout } = await execFileAsync("rg", args, {
      cwd: root,
      timeout: SNIPPET_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (err: unknown) {
    const e = err as { code?: string | number; message?: string };
    if (e.code === 1) return ""; // no matches
    return null; // rg unavailable → fallback chain
  }
}

interface SnippetHit { file: string; line: number; text: string }

/**
 * Parse raw engine output ("path:line: text" lines, rg group separators "--")
 * or synthesize per-hit context by reading files, then emit the grouped
 * snippet format with read_file hints.
 */
async function formatSnippets(raw: string, pattern: string, engine: SearchResult["engine"]): Promise<SearchResult> {
  const hitMap = new Map<string, SnippetHit[]>();
  for (const rawLine of raw.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed === "--") continue; // rg group separator
    const m = trimmed.match(/^(.+?):(\d+): ?(.*)$/);
    if (!m) continue;
    const [, file, lineStr, text] = m;
    const lineNo = parseInt(lineStr, 10);
    if (!Number.isFinite(lineNo)) continue;
    const hits = hitMap.get(file) || [];
    hits.push({ file, line: lineNo, text: text.slice(0, 300) });
    hitMap.set(file, hits);
  }

  if (hitMap.size === 0) {
    return { engine, output: `No matches for "${pattern}"`, truncated: false, matchCount: 0 };
  }

  const files = [...hitMap.keys()].slice(0, 10);
  const sections: string[] = [];
  let matchCount = 0;
  let truncated = false;
  let bytes = 0;

  for (const file of files) {
    const hits = hitMap.get(file)!;
    matchCount += hits.length;
    const relFile = file.replace(/\\/g, "/").replace(/^\.\//, "");
    const lines: string[] = [`## ${relFile} (${hits.length} match${hits.length === 1 ? "" : "es"})`];
    for (const hit of hits.slice(0, 5)) {
      // rg -C already embeds context lines in its raw output; fallback
      // engines emit the match line only (still enough to locate a region).
      lines.push(
        `${relFile}:${hit.line}: ${hit.text}` +
        `\n  → read_file "${relFile}" offset=${Math.max(1, hit.line - SNIPPET_CONTEXT_LINES)} limit=${SNIPPET_CONTEXT_LINES * 2 + 5}`
      );
    }
    if (hits.length > 5) lines.push(`  … ${hits.length - 5} more match(es) in this file — refine the query`);
    const section = lines.join("\n");
    if (bytes + section.length > SNIPPET_MAX_OUTPUT_BYTES) { truncated = true; break; }
    bytes += section.length;
    sections.push(section);
  }

  const output = sections.join("\n\n") + (truncated ? `\n…[capped at ${SNIPPET_MAX_OUTPUT_BYTES / 1000} kB — refine the query]` : "");
  return { engine, output, truncated, matchCount };
}

/**
 * Search `rootDir` for `pattern`. Tries rg → git grep → node scan in order,
 * returning the first engine that produces a definitive result.
 * `isRegex: false` (the default) treats the pattern as a literal string.
 */
export async function grepSearch(
  rootDir: string,
  pattern: string,
  opts: { isRegex?: boolean; perFileLimit?: number } = {}
): Promise<SearchResult | null> {
  const root = resolveRoot(rootDir);
  if (!root || !pattern || pattern.length > 500) return null;
  const isRegex = opts.isRegex ?? false;
  const perFileLimit = Math.max(1, Math.min(SNIPPET_MAX_MATCHES, Math.floor(opts.perFileLimit ?? 5)));

  const engines: Array<[SearchResult["engine"], () => Promise<string | null>]> = [
    ["ripgrep", () => tryRipgrep(root, pattern, isRegex, perFileLimit)],
    ["gitgrep", () => tryGitGrep(root, pattern, isRegex, perFileLimit)],
    ["node", () => nodeScan(root, pattern, isRegex, perFileLimit)],
  ];

  for (const [engine, run] of engines) {
    const raw = await run();
    if (raw === null) continue; // engine unavailable — try the next
    const capped = capOutput(raw);
    return { engine, ...capped };
  }
  return null; // every engine failed to run at all
}
