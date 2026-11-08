export type DiffLineKind = "add" | "remove" | "context" | "hunk";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface FileDiff {
  added: number;
  removed: number;
  lines: DiffLine[];
}

interface Edit {
  kind: "equal" | "add" | "remove";
  text: string;
}

function myers(oldLines: string[], newLines: string[]): Edit[] {
  const max = oldLines.length + newLines.length;
  const trace: Map<number, number>[] = [];
  let frontier = new Map<number, number>([[1, 0]]);

  for (let distance = 0; distance <= max; distance++) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? -1;
      const right = frontier.get(diagonal - 1) ?? -1;
      let x = diagonal === -distance || (diagonal !== distance && right < down)
        ? down
        : right + 1;
      if (x < 0) x = 0;
      let y = x - diagonal;

      while (x < oldLines.length && y < newLines.length && oldLines[x] === newLines[y]) {
        x += 1;
        y += 1;
      }
      frontier.set(diagonal, x);

      if (x >= oldLines.length && y >= newLines.length) {
        return backtrack(trace, oldLines, newLines, distance);
      }
    }
  }
  return [];
}

function backtrack(trace: Map<number, number>[], oldLines: string[], newLines: string[], distance: number): Edit[] {
  let x = oldLines.length;
  let y = newLines.length;
  const reversed: Edit[] = [];

  for (let d = distance; d > 0; d--) {
    const frontier = trace[d];
    const diagonal = x - y;
    const down = frontier.get(diagonal + 1) ?? -1;
    const right = frontier.get(diagonal - 1) ?? -1;
    const previousDiagonal = diagonal === -d || (diagonal !== d && right < down)
      ? diagonal + 1
      : diagonal - 1;
    const previousX = frontier.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;

    while (x > previousX && y > previousY) {
      reversed.push({ kind: "equal", text: oldLines[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (x === previousX) {
      reversed.push({ kind: "add", text: newLines[y - 1] });
      y -= 1;
    } else {
      reversed.push({ kind: "remove", text: oldLines[x - 1] });
      x -= 1;
    }
  }

  while (x > 0 && y > 0 && oldLines[x - 1] === newLines[y - 1]) {
    reversed.push({ kind: "equal", text: oldLines[x - 1] });
    x -= 1;
    y -= 1;
  }
  while (x > 0) {
    reversed.push({ kind: "remove", text: oldLines[--x] });
  }
  while (y > 0) {
    reversed.push({ kind: "add", text: newLines[--y] });
  }
  return reversed.reverse();
}

function lineChanges(edits: Edit[]): DiffLine[] {
  let oldLine = 1;
  let newLine = 1;
  return edits.map((edit) => {
    if (edit.kind === "equal") {
      return { kind: "context", text: edit.text, oldLine: oldLine++, newLine: newLine++ };
    }
    if (edit.kind === "remove") {
      return { kind: "remove", text: edit.text, oldLine: oldLine++, newLine };
    }
    return { kind: "add", text: edit.text, oldLine, newLine: newLine++ };
  });
}

function withHunks(lines: DiffLine[], context: number): DiffLine[] {
  const changed: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== "context") changed.push(i);
  }
  if (!changed.length) return [];

  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) last.end = end;
    else ranges.push({ start, end });
  }

  const output: DiffLine[] = [];
  for (const range of ranges) {
    const chunk = lines.slice(range.start, range.end + 1);
    const first = chunk[0];
    const oldStart = first.oldLine ?? first.newLine ?? 1;
    const newStart = first.newLine ?? first.oldLine ?? 1;
    const oldCount = chunk.filter((line) => line.kind !== "add").length;
    const newCount = chunk.filter((line) => line.kind !== "remove").length;
    output.push({
      kind: "hunk",
      text: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    });
    output.push(...chunk);
  }
  return output;
}

/** Myers line diff with unified hunks and three context lines. */
export function diffFileLines(before: string | null, after: string | null, context = 3): FileDiff {
  if (before === after) return { added: 0, removed: 0, lines: [] };
  if (before === null) {
    const lines = (after ?? "").split("\n");
    return {
      added: lines.length,
      removed: 0,
      lines: [
        { kind: "hunk", text: "@@ new file @@" },
        ...lines.map((text, index) => ({ kind: "add" as const, text, newLine: index + 1 })),
      ],
    };
  }
  if (after === null) {
    const lines = before.split("\n");
    return {
      added: 0,
      removed: lines.length,
      lines: [
        { kind: "hunk", text: "@@ deleted file @@" },
        ...lines.map((text, index) => ({ kind: "remove" as const, text, oldLine: index + 1 })),
      ],
    };
  }

  const edits = myers(before.split("\n"), after.split("\n"));
  const full = lineChanges(edits);
  return {
    added: edits.filter((edit) => edit.kind === "add").length,
    removed: edits.filter((edit) => edit.kind === "remove").length,
    lines: withHunks(full, context),
  };
}
