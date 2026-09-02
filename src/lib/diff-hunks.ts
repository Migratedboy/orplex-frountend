// diff-hunks.ts — Hunk-level diff parsing and application.
//
// Splits a line-based diff (the simple +/- format produced by file-history.ts
// computeDiff) into reviewable hunks, so the UI can accept or reject each
// hunk independently instead of per-file or per-run.

export interface DiffHunk {
  /** Stable id for React keys — index within the diff */
  id: number;
  lines: DiffLine[];
  added: number;
  removed: number;
}

export interface DiffLine {
  type: "add" | "remove" | "context";
  text: string;
}

/**
 * Parse a simple unified-ish diff (lines prefixed with "+ ", "- ", or context)
 * into hunks. A hunk is a run of changes plus one line of surrounding context
 * where available. New-file diffs (all "+") produce a single hunk.
 */
export function parseDiffHunks(diff: string): DiffHunk[] {
  if (!diff || diff === "(no changes)") return [];

  const rawLines = diff.split("\n");

  // Strip file headers like "--- path" / "+++ path"
  const lines = rawLines.filter(l => !l.startsWith("--- ") && !l.startsWith("+++ "));

  // New-file summary header, e.g. "+ [New file: 42 lines]" — keep as a hunk header
  const isNewFileHeader = lines[0]?.startsWith("+ [New file:");

  const hunks: DiffHunk[] = [];
  let current: DiffLine[] = [];
  let added = 0;
  let removed = 0;

  const flush = () => {
    if (current.length === 0) return;
    hunks.push({ id: hunks.length, lines: current, added, removed });
    current = [];
    added = 0;
    removed = 0;
  };

  // Track consecutive context lines so we can break hunks after 2+ context lines
  let contextRun = 0;

  for (const line of lines) {
    if (line.startsWith("+ ")) {
      current.push({ type: "add", text: line.slice(2) });
      added++;
      contextRun = 0;
    } else if (line.startsWith("- ")) {
      current.push({ type: "remove", text: line.slice(2) });
      removed++;
      contextRun = 0;
    } else if (line.startsWith("+") && !line.startsWith("++")) {
      // New-file lines sometimes have a single "+" without space
      current.push({ type: "add", text: line.slice(1) });
      added++;
      contextRun = 0;
    } else {
      // Context or summary lines ("... (N more changes)", "[N added, M removed]")
      current.push({ type: "context", text: line });
      contextRun++;
      // Two or more context lines end the hunk (if it has changes)
      if (contextRun >= 2 && (added > 0 || removed > 0)) {
        flush();
      }
    }
  }
  flush();

  // A pure new-file diff is one hunk
  if (isNewFileHeader && hunks.length > 1) {
    return [hunks[0]];
  }

  return hunks;
}

/**
 * Apply hunk-level accept/reject decisions, returning the resulting diff text.
 * Rejected hunks are dropped; accepted hunks are kept verbatim.
 * The caller re-derives file content from the surviving diff via applyDiffToText.
 */
export function filterDiffByHunks(diff: string, acceptedHunkIds: Set<number>): string {
  const hunks = parseDiffHunks(diff);
  const kept: string[] = [];
  for (const hunk of hunks) {
    if (!acceptedHunkIds.has(hunk.id)) continue;
    for (const line of hunk.lines) {
      if (line.type === "add") kept.push(`+ ${line.text}`);
      else if (line.type === "remove") kept.push(`- ${line.text}`);
      else kept.push(line.text);
    }
  }
  return kept.join("\n");
}

/**
 * Reconstruct file content from an old text plus a filtered diff.
 * Walks old lines; removals and context advance the old cursor, additions
 * are inserted at the current position.
 */
export function applyDiffToText(oldText: string, diff: string): string {
  const oldLines = oldText.split("\n");
  const result: string[] = [];
  let cursor = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+ ")) {
      result.push(line.slice(2));
    } else if (line.startsWith("- ")) {
      // Skip the removed old line
      cursor++;
    } else if (line.startsWith("(no changes)")) {
      // no-op
    } else {
      // Context line — copy the corresponding old line when available
      if (cursor < oldLines.length) {
        result.push(oldLines[cursor]);
      }
      cursor++;
    }
  }

  // Preserve any trailing old lines the diff didn't mention
  while (cursor < oldLines.length) {
    result.push(oldLines[cursor]);
    cursor++;
  }

  return result.join("\n");
}
