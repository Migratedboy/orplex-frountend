// project-memory.ts — orplex.md project memory (Claude Code's CLAUDE.md parity).
//
// A hierarchy of markdown files the user owns, injected into every agent
// system prompt for that workspace:
//
//   <root>/orplex.md            — repo-wide conventions (highest level)
//   <root>/.orplex/orplex.md    — alternative location, merged after root
//   <root>/<subdir>/orplex.md   — subdir override when the task touches it
//
// Token discipline (8k-TPM free tier): the full profile sends each file's
// first MAX_FULL_CHARS; the essentials profile (repair/continuation turns)
// sends only the first `## ` section marked `<!-- essentials -->` per file
// (or the first MAX_ESSENTIALS_CHARS when no marker exists).
//
// Pure functions + tiny fs reads, cached for 60s so per-turn cost is nil.

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

export const MEMORY_FILENAME = "orplex.md";
export const MAX_FULL_CHARS = 6_000;
export const MAX_ESSENTIALS_CHARS = 2_000;
const CACHE_MS = 60_000;

export interface ProjectMemoryFile {
  /** Path relative to the workspace root (posix separators). */
  source: string;
  content: string;
}

const cache = new Map<string, { at: number; files: ProjectMemoryFile[] }>();

/** Test hook. */
export function clearProjectMemoryCache(): void {
  cache.clear();
}

function relPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

async function readIfPresent(abs: string, rel: string): Promise<ProjectMemoryFile | null> {
  try {
    if (!existsSync(abs)) return null;
    const raw = await readFile(abs, "utf8");
    if (!raw.trim()) return null;
    return { source: rel, content: raw };
  } catch {
    return null;
  }
}

/** Load the memory hierarchy for a workspace root. Never throws. */
export async function loadProjectMemory(rootDir: string): Promise<ProjectMemoryFile[]> {
  const cached = cache.get(rootDir);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.files;

  const files: ProjectMemoryFile[] = [];
  const root = await readIfPresent(join(rootDir, MEMORY_FILENAME), MEMORY_FILENAME);
  if (root) files.push(root);
  const dot = await readIfPresent(join(rootDir, ".orplex", MEMORY_FILENAME), `.orplex/${MEMORY_FILENAME}`);
  if (dot) files.push(dot);

  cache.set(rootDir, { at: Date.now(), files });
  if (cache.size > 50) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return files;
}

/**
 * Extract the "essentials" slice of one memory file: content under a
 * `<!-- essentials -->` … `<!-- /essentials -->` pair when present, else the
 * first MAX_ESSENTIALS_CHARS.
 */
export function essentialsOf(content: string): string {
  const m = content.match(/<!--\s*essentials\s*-->([\s\S]*?)(?:<!--\s*\/essentials\s*-->|$)/i);
  const slice = (m ? m[1] : content).trim();
  return slice.slice(0, MAX_ESSENTIALS_CHARS);
}

/**
 * Render the memory block for a system prompt.
 * profile "full" = first MAX_FULL_CHARS of every file;
 * profile "essentials" = the essentials slice of every file.
 */
export function renderProjectMemory(files: ProjectMemoryFile[], profile: "full" | "essentials"): string {
  if (files.length === 0) return "";
  const parts = files.map((f) => {
    const body = profile === "full" ? f.content.slice(0, MAX_FULL_CHARS) : essentialsOf(f.content);
    return `<project_memory source="${f.source}">\n${body}\n</project_memory>`;
  });
  return parts.join("\n\n");
}

/** Convenience: load + render in one call. */
export async function projectMemoryBlock(rootDir: string, profile: "full" | "essentials" = "full"): Promise<string> {
  const files = await loadProjectMemory(rootDir);
  return renderProjectMemory(files, profile);
}
