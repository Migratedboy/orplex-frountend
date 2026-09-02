// File change history — tracks all writes for undo/rollback

interface FileChange {
  path: string;
  previousContent: string | null; // null = new file
  newContent: string;
  timestamp: number;
}

const history: FileChange[] = [];
const MAX_HISTORY = 50;

/** Record a file change (call BEFORE writing) */
export function recordChange(path: string, previousContent: string | null, newContent: string) {
  history.unshift({ path, previousContent, newContent, timestamp: Date.now() });
  if (history.length > MAX_HISTORY) history.pop();
}

/** Get the last N changes */
export function getRecentChanges(limit = 10): FileChange[] {
  return history.slice(0, limit);
}

/** Peek at the previous content without removing the history entry */
export function getPreviousContent(path: string): string | null {
  const idx = history.findIndex(c => c.path === path);
  if (idx === -1) return null;
  return history[idx].previousContent;
}

/** Undo the last change to a specific file — returns the previous content */
export function undoLastChange(path: string): string | null {
  const idx = history.findIndex(c => c.path === path);
  if (idx === -1) return null;
  const change = history[idx];
  history.splice(idx, 1);
  return change.previousContent;
}

/** Generate a simple unified diff between two strings */
export function computeDiff(oldText: string | null, newText: string): string {
  if (oldText === null) {
    // New file
    const lines = newText.split("\n");
    if (lines.length <= 5) {
      return lines.map(l => `+ ${l}`).join("\n");
    }
    return `+ [New file: ${lines.length} lines]\n${lines.slice(0, 3).map(l => `+ ${l}`).join("\n")}\n+ ...`;
  }

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const diff: string[] = [];

  // Simple line-by-line diff
  const maxLen = Math.max(oldLines.length, newLines.length);
  let contextStart = -1;

  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];

    if (oldLine !== newLine) {
      if (contextStart === -1) contextStart = Math.max(0, i - 1);
      if (oldLine !== undefined) diff.push(`- ${oldLine}`);
      if (newLine !== undefined) diff.push(`+ ${newLine}`);
    }
  }

  if (diff.length === 0) return "(no changes)";

  // Compact: if more than 20 lines changed, summarize
  if (diff.length > 20) {
    const added = diff.filter(l => l.startsWith("+")).length;
    const removed = diff.filter(l => l.startsWith("-")).length;
    return `[${added} lines added, ${removed} lines removed]\n${diff.slice(0, 10).join("\n")}\n... (${diff.length - 10} more changes)`;
  }

  return diff.join("\n");
}
