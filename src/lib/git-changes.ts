/**
 * git-changes.ts — pure parsers for the Changes tab git shape (Right Panel
 * v2, P3; DECISIONS D8). The route shells out to git; the parsing lives here
 * so it is unit-testable without a repo.
 *
 * Data consumed:
 * - `git status --porcelain=v1 -z`  (or `git status --porcelain=v1` fallback)
 * - `git diff --numstat HEAD`      (committed line counts; untracked excluded)
 * - `git diff --numstat -z <merge-base>...HEAD` (committed-on-branch counts)
 */

export type GitChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface GitChangeRow {
  path: string;
  status: GitChangeStatus;
  added: number;
  deleted: number;
}

export interface GitChangesResult {
  isGitRepo: boolean;
  branch: string | null;
  rows: GitChangeRow[];
  totals: { added: number; deleted: number };
  truncated: boolean;
}

function statusOf(xy: string): GitChangeStatus | null {
  const x = xy[0] ?? " ";
  const y = xy[1] ?? " ";
  if (x === "?" && y === "?") return "added"; // untracked
  if (x === "R" || y === "R") return "renamed";
  if (x === "D" || y === "D") return "deleted";
  if (x === "A") return "added";
  // M, T, or blank-both-in-index with worktree dim — modified unless wholly clean.
  if (x !== " " || y !== " ") return "modified";
  return null;
}

/**
 * Parse `git status --porcelain=v1` output. With `-z`, lines are
 * NUL-separated and rename entries emit the destination path line then a
 * source line following the same XY header (two entries per rename).
 */
export function parsePorcelain(raw: string, z: boolean): GitChangeRow[] {
  if (!raw.trim()) return [];
  const rows: GitChangeRow[] = [];
  if (z) {
    const parts = raw.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.length < 4) continue;
      const xy = part.slice(0, 2);
      const status = statusOf(xy);
      if (!status) continue;
      let path = part.slice(3);
      if (status === "renamed") {
        // -z rename: "<XY> dest\0src" — the NEXT part is the source path and
        // is skipped (git format pairs them). Keep destination as the row.
        const choice = parts[i + 1];
        if (typeof choice === "string" && choice.length >= 1) {
          path = `${choice} -> ${part.slice(3)}`;
          i += 1;
        }
      }
      rows.push({ path, status, added: 0, deleted: 0 });
    }
  } else {
    for (const line of raw.split("\n")) {
      if (line.length < 4) continue;
      const xy = line.slice(0, 2);
      const status = statusOf(xy);
      if (!status) continue;
      let path = line.slice(3);
      if (status === "renamed") {
        const arrow = path.indexOf(" -> ");
        if (arrow !== -1) {
          const src = path.slice(0, arrow);
          const dst = path.slice(arrow + 4);
          path = `${src} -> ${dst}`;
        }
      }
      rows.push({ path, status, added: 0, deleted: 0 });
    }
  }
  return rows;
}

/**
 * Parse `git diff --numstat` output ("added<TAB>deleted<TAB>path"). Binary
 * files show "-" as counts → 0. -z rename entries: "a\td\t\0src\0dst\0".
 * Returns a path-keyed map of line counts.
 */
export function parseNumstat(raw: string, z: boolean): Map<string, { added: number; deleted: number }> {
  const out = new Map<string, { added: number; deleted: number }>();
  const num = (s: string) => (s === "-" ? 0 : Number.parseInt(s, 10) || 0);
  if (z) {
    const fields = raw.split("\0");
    for (let i = 0; i < fields.length; ) {
      const field = fields[i];
      if (!field || !field.includes("\t")) { i++; continue; }
      const [a, d] = field.split("\t");
      const src = fields[i + 1] ?? "";
      const dst = fields[i + 2] ?? "";
      if (dst) {
        out.set(`${src} -> ${dst}`, { added: num(a), deleted: num(d) });
        out.set(dst, { added: num(a), deleted: num(d) });
        i += 3;
      } else {
        out.set(src, { added: num(a), deleted: num(d) });
        i += 2;
      }
    }
    return out;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    out.set(m[3], { added: num(m[1]), deleted: num(m[2]) });
  }
  return out;
}

/** Merge numstat counts onto status rows; compute totals. */
export function mergeCounts(
  rows: GitChangeRow[],
  counts: Map<string, { added: number; deleted: number }>
): GitChangesResult["rows"] {
  return rows.map((r) => {
    const c = counts.get(r.path) ?? counts.get(r.path.split(" -> ").pop() ?? r.path);
    return { ...r, added: c?.added ?? 0, deleted: c?.deleted ?? 0 };
  });
}

export function totalsOf(rows: GitChangeRow[]): { added: number; deleted: number } {
  return rows.reduce(
    (acc, r) => ({ added: acc.added + r.added, deleted: acc.deleted + r.deleted }),
    { added: 0, deleted: 0 }
  );
}
