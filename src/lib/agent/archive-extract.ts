// Archive extraction for the agent tool lane.
//
// Backed by jszip (already a dependency) so no new package is introduced.
// Every entry is containment-checked before it touches disk: a malicious
// archive can carry entries named "../../.ssh/authorized_keys" or absolute
// paths, and an agent that extracts those verbatim would write outside the
// workspace.

// The tool lane is in the BROWSER graph as well as the server one:
// background-worker.ts is dynamically imported from useChatSession and
// RightPanel, and it imports native-tools. A static `node:fs/promises` import
// here therefore breaks the browser build ("chunking context does not support
// external modules"). Node built-ins are loaded lazily inside the functions
// that need them, and callers run this server-side — the browser lane has no
// workspace disk to extract into anyway.

import JSZip from "jszip";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Refuse absurd inputs before spending CPU/memory on them. */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024; // 100MB on disk
export const MAX_ENTRIES = 2_000;
export const MAX_TOTAL_OUT_BYTES = 200 * 1024 * 1024; // 200MB extracted
export const MAX_ENTRY_OUT_BYTES = 50 * 1024 * 1024; // 50MB per file
/** Windows rejects these in filenames; also common junk we never want.
 *  Keys MUST be lowercase — comparisons lowercase the candidate. */
const BLOCKED_BASENAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

export interface ExtractEntry {
  path: string;
  bytes: number;
  skipped?: "directory" | "too-large" | "blocked-name" | "escapes-root" | "symlink";
}

export interface ExtractResult {
  ok: boolean;
  dest: string;
  written: ExtractEntry[];
  skipped: ExtractEntry[];
  /** Human-readable summary for the model's <tool_result>. */
  summary: string;
  error?: string;
}

/**
 * Resolve `p` against `root` and require it to stay inside.
 * Returns null when the path escapes the root.
 */
export function containPath(root: string, p: string): string | null {
  const rootAbs = resolve(root);
  const full = isAbsolute(p) ? resolve(p) : resolve(rootAbs, p);
  if (full !== rootAbs && !full.startsWith(rootAbs + sep)) return null;
  return full;
}

/** Normalise a zip entry name to a safe relative path, or null to reject it. */
export function safeEntryName(raw: string): string | null {
  // Zip paths always use forward slashes, including on Windows-authored zips.
  const norm = raw.replace(/\\/g, "/");
  if (!norm || norm.endsWith("/")) return null; // directory
  // Absolute (POSIX or Windows drive/UNC) → reject outright.
  if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)) return null;
  // NUL byte truncation attempt.
  if (norm.includes("\0")) return null;

  const parts: string[] = [];
  for (const seg of norm.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null; // zip-slip
    parts.push(seg);
  }
  if (parts.length === 0) return null;

  const base = parts[parts.length - 1];
  if (BLOCKED_BASENAMES.has(base.toLowerCase())) return null;
  // A segment that is all dots ("...") is not traversal but is pathological.
  if (parts.some((s) => /^\.+$/.test(s))) return null;

  return parts.join("/");
}

/**
 * Default output directory for an archive: `<parent>/<name-without-ext>/`.
 *
 * Attached archives live in `.orplex/attachments/<hash>.zip`, which is the
 * app's own state directory — extracting there would bury the user's project
 * files under `.orplex/attachments/<hash>/`. So when the archive comes from
 * the attachment store, the destination is the WORKSPACE ROOT instead, named
 * after the original upload where we can recover it.
 */
export function defaultDest(archivePath: string, originalName?: string): string {
  const stem =
    (originalName && originalName.replace(/\.[^.]+$/, "")) ||
    (archivePath.split("/").pop() || "archive").replace(/\.[^.]+$/, "");
  // Never default into our own state dir.
  if (/(^|\/)\.orplex\/attachments\//.test(archivePath)) return stem;
  const slash = archivePath.lastIndexOf("/");
  const dir = slash === -1 ? "" : archivePath.slice(0, slash);
  return dir ? `${dir}/${stem}` : stem;
}

/**
 * Extract a zip archive found at `archivePath` (relative to `root`, or
 * absolute and already contained) into `destRel`.
 */
export async function extractZip(args: {
  root: string;
  archivePath: string;
  destRel?: string;
}): Promise<ExtractResult> {
  const { root, archivePath } = args;
  const rootAbs = resolve(root);
  const archiveAbs = containPath(rootAbs, archivePath);
  if (!archiveAbs) {
    return {
      ok: false,
      dest: "",
      written: [],
      skipped: [],
      summary: "Refused: archive path escapes the workspace.",
      error: "path-escapes-root",
    };
  }

  let size: number;
  try {
    const { stat } = await import("node:fs/promises");
    const st = await stat(archiveAbs);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    return {
      ok: false,
      dest: "",
      written: [],
      skipped: [],
      summary: `Archive not found: ${archivePath}`,
      error: "not-found",
    };
  }
  if (size > MAX_ARCHIVE_BYTES) {
    return {
      ok: false,
      dest: "",
      written: [],
      skipped: [],
      summary: `Archive is ${(size / 1024 / 1024).toFixed(1)}MB, over the ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB limit.`,
      error: "too-large",
    };
  }

  let zip: JSZip;
  try {
    const { readFile } = await import("node:fs/promises");
    zip = await JSZip.loadAsync(await readFile(archiveAbs));
  } catch (e) {
    return {
      ok: false,
      dest: "",
      written: [],
      skipped: [],
      summary: `Not a readable zip archive: ${e instanceof Error ? e.message : String(e)}`,
      error: "corrupt",
    };
  }

  const destRel = args.destRel?.trim() || defaultDest(archivePath);
  const destAbs = containPath(rootAbs, destRel);
  if (!destAbs) {
    return {
      ok: false,
      dest: destRel,
      written: [],
      skipped: [],
      summary: "Refused: destination escapes the workspace.",
      error: "dest-escapes-root",
    };
  }

  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES) {
    return {
      ok: false,
      dest: destRel,
      written: [],
      skipped: [],
      summary: `Archive has ${entries.length} entries, over the ${MAX_ENTRIES} limit.`,
      error: "too-many-entries",
    };
  }

  const written: ExtractEntry[] = [];
  const skipped: ExtractEntry[] = [];
  let totalOut = 0;

  const { mkdir } = await import("node:fs/promises");
  await mkdir(destAbs, { recursive: true });

  for (const entry of entries) {
    if (entry.dir) {
      skipped.push({ path: entry.name, bytes: 0, skipped: "directory" });
      continue;
    }

    const rel = safeEntryName(entry.name);
    if (!rel) {
      skipped.push({ path: entry.name, bytes: 0, skipped: "escapes-root" });
      continue;
    }

    const target = resolve(destAbs, rel);
    // Second containment check on the RESOLVED target: safeEntryName strips
    // "..", but this also catches anything that slipped through on Windows
    // path semantics or an exotic unicode separator.
    if (target !== destAbs && !target.startsWith(destAbs + sep)) {
      skipped.push({ path: entry.name, bytes: 0, skipped: "escapes-root" });
      continue;
    }

    const bytes = await entry.async("nodebuffer");
    if (bytes.length > MAX_ENTRY_OUT_BYTES) {
      skipped.push({ path: rel, bytes: bytes.length, skipped: "too-large" });
      continue;
    }
    if (totalOut + bytes.length > MAX_TOTAL_OUT_BYTES) {
      skipped.push({ path: rel, bytes: bytes.length, skipped: "too-large" });
      continue;
    }

    try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
      totalOut += bytes.length;
      written.push({ path: rel, bytes: bytes.length });
    } catch (e) {
      skipped.push({
        path: rel,
        bytes: 0,
        skipped: "blocked-name",
      });
      void e;
    }
  }

  const lines: string[] = [];
  lines.push(
    `Extracted ${written.length} file(s) from ${archivePath} into ${destRel}/ (${(totalOut / 1024).toFixed(1)} KB).`,
  );
  if (written.length) {
    const shown = written.slice(0, 40);
    lines.push(...shown.map((w) => `  ${w.path} (${w.bytes} B)`));
    if (written.length > shown.length) {
      lines.push(`  … and ${written.length - shown.length} more`);
    }
  }
  if (skipped.length) {
    lines.push(
      `Skipped ${skipped.length} entr${skipped.length === 1 ? "y" : "ies"}: ` +
        summarizeSkips(skipped),
    );
  }
  if (written.length) {
    lines.push(`Read them with read_file, e.g. read_file path="${destRel}/${written[0].path}".`);
  }

  return { ok: true, dest: destRel, written, skipped, summary: lines.join("\n") };
}

function summarizeSkips(skipped: ExtractEntry[]): string {
  const by: Record<string, number> = {};
  for (const s of skipped) {
    const k = s.skipped || "other";
    by[k] = (by[k] || 0) + 1;
  }
  return Object.entries(by)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
}

/** Convenience for callers holding a workspace root + relative archive path. */
export function describeRelative(root: string, p: string): string {
  return relative(resolve(root), p) || p;
}
