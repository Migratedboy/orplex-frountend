/**
 * reliability/path-jail.ts — the SHARED realpath-based path jail (audit §Phase3
 * "Path jail: containPath with real lstat+realpath — archive only").
 *
 * Factored from src/lib/agent/archive-extract.ts: its lexical `containPath`
 * (resolve + startsWith) PLUS the inline lstat/realpath walk in `extractZip`
 * that rejects pre-existing symlinks/junctions pointing outside the root.
 * That walk only protected archive extraction; the server executor still uses
 * lexical resolve+startsWith with no realpath, and the browser lane has no
 * check at all. This module is the one containment implementation both lanes
 * (and any future write path) should import — same logic, minus the archive
 * assumptions:
 *  - the workspace root itself MAY be a symlink (archive code rejects any
 *    symlink; a user's workspace legitimately lives behind one, so the root
 *    is realpath'd and compared against itself instead);
 *  - nothing exists under a brand-new root yet, so the walk stops at the root
 *    rather than escaping upward the way the archive walk would.
 *
 * As with archive-extract, node:fs/promises is imported lazily: this module
 * can be pulled into the browser-graph import chain (via native-tools) and a
 * static Node builtin import breaks that build. Callers run it server-side.
 *
 * The write denylist (WRITE_DENY_PATTERNS) is the archive FORBIDDEN_DEST
 * set (.git/.hg/.svn/.orplex) grown into the full secrets denylist the audit
 * found missing: write_file({path:".git/hooks/post-checkout"}) passes today.
 */
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Paths (workspace-relative, trailing "/" = any path under that directory
 * segment; "*." prefix = extension; "." glob = prefix) that agent writes must
 * never touch, however they are reached. The trailing-slash entries match a
 * path SEGMENT anywhere in the path; the rest match the final basename.
 */
export const WRITE_DENY_PATTERNS = [
  ".git/",
  ".hg/",
  ".svn/",
  ".orplex/",
  ".env",
  ".env.*",
  "id_rsa",
  "id_ed25519",
  "*.pem",
  "credentials.json",
  ".aws/",
  ".ssh/",
] as const;

const SEGMENT_PATTERNS = WRITE_DENY_PATTERNS.filter((p) => p.endsWith("/")).map((p) =>
  p.slice(0, -1).toLowerCase(),
);

/**
 * Pure lexical check against WRITE_DENY_PATTERNS. No I/O: this is the cheap
 * deny that runs on EVERY write, not a substitute for containPath.
 * Case-insensitive and separator-agnostic (Windows and POSIX paths both OK).
 */
export function isWriteDenied(absPath: string): { denied: boolean; reason?: string } {
  const segments = absPath
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s.length > 0);

  for (const segment of segments) {
    const lower = segment.toLowerCase();
    const hit = SEGMENT_PATTERNS.find((p) => p === lower);
    if (hit) {
      return { denied: true, reason: `writes into "${hit}/" are refused (control directory)` };
    }
  }

  const base = segments.length > 0 ? segments[segments.length - 1] : "";
  const lowerBase = base.toLowerCase();
  // NTFS alternate data streams (::\$DATA) bypass extension/basename checks.
  if (absPath.includes("::")) {
    return { denied: true, reason: `writes to NTFS alternate data streams are refused (secret material)` };
  }
  for (const pattern of WRITE_DENY_PATTERNS) {
    if (pattern.endsWith("/")) continue;
    if (pattern.startsWith("*.")) {
      // Extension glob, e.g. "*.pem".
      if (lowerBase.endsWith(pattern.slice(1))) {
        return { denied: true, reason: `writes to "${pattern}" files are refused (secret material)` };
      }
    } else if (pattern.includes("*")) {
      // Prefix glob, e.g. ".env.*" → basename starts with ".env.".
      const prefix = pattern.slice(0, pattern.indexOf("*"));
      if (lowerBase.startsWith(prefix)) {
        return { denied: true, reason: `writes to "${pattern}" files are refused (secret material)` };
      }
    } else if (lowerBase === pattern) {
      return { denied: true, reason: `writes to "${pattern}" are refused (secret material)` };
    }
  }

  return { denied: false };
}

/**
 * Resolve `targetPath` against `rootDir` and require it to STAY inside,
 * following symlinks: the lexical check catches "../" by text, the lstat/
 * realpath walk catches a pre-existing symlink in the path that points
 * anywhere on disk (Windows junctions and repo symlinks are common, and
 * mkdir/writeFile both follow them).
 */
export async function containPath(
  rootDir: string,
  targetPath: string,
): Promise<{ ok: true; abs: string } | { ok: false; reason: string }> {
  const rootAbs = resolve(rootDir);
  // A path that is absolute on ANOTHER platform (Windows drive, UNC share)
  // can never be inside the workspace — reject it before it is joined onto
  // the root, which on Linux would turn "C:/Windows/x" into a relative path.
  if (/^[a-zA-Z]:[\\/]/.test(targetPath) || targetPath.startsWith("\\\\") || targetPath.startsWith("//")) {
    return { ok: false, reason: `"${targetPath}" is an absolute path outside the workspace root` };
  }
  const full = isAbsolute(targetPath) ? resolve(targetPath) : resolve(rootAbs, targetPath);
  // Lexical containment — the same first gate as archive-extract's containPath.
  if (full !== rootAbs && !full.startsWith(rootAbs + sep)) {
    return { ok: false, reason: `"${targetPath}" escapes the workspace root` };
  }

  const { lstat, realpath } = await import("node:fs/promises");
  // The root itself may sit behind a symlink (user's home, /tmp, a mounted
  // drive) — compare realpath'd targets against the REAL root, or every path
  // in such a workspace would be a false escape.
  const realRoot = await realpath(rootAbs).catch(() => rootAbs);

  try {
    // Walk up from the target to the first existing ancestor and re-contain
    // THAT against the real root — the target usually does not exist yet.
    let probe = full;
    for (;;) {
      const st = await lstat(probe).catch(() => null);
      if (st) {
        // A symlink/junction in the path is never acceptable, exactly as in
        // extractZip — except at the root, which we just realpath'd above.
        if (st.isSymbolicLink() && probe !== rootAbs) {
          return {
            ok: false,
            reason: `"${targetPath}" traverses a symlink/junction — writes through link aliases are refused`,
          };
        }
        const real = await realpath(probe);
        if (real !== realRoot && !real.startsWith(realRoot + sep)) {
          return { ok: false, reason: `"${targetPath}" resolves outside the workspace root` };
        }
        break;
      }
      // Nothing exists from the target up to the root — no link can hide
      // under it, and the write's own mkdir will create the rest. Only treat
      // the root as a safe no-op stop when it actually exists; a missing root
      // must not let the walk skip containment (junction-ancestor escape).
      if (probe === rootAbs) {
        const rootStat = await lstat(rootAbs).catch(() => null);
        if (rootStat) break;
        return { ok: false, reason: `"${targetPath}" could not be containment-checked: workspace root does not exist` };
      }
      const parent = dirname(probe);
      if (parent === probe) break; // reached the filesystem root
      probe = parent;
    }
  } catch (e) {
    return {
      ok: false,
      reason: `"${targetPath}" could not be containment-checked: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return { ok: true, abs: full };
}

/**
 * The one call a write path should make before touching disk: containment
 * FIRST (a path that escapes the root never gets a denylist reason leak),
 * then the denylist — applied to the path WITHIN the workspace, the same
 * choice archive-extract's destIsForbidden makes, so a workspace merely
 * located under a control directory is not blanket-refused.
 */
export async function assertSafeWrite(
  rootDir: string,
  targetPath: string,
): Promise<{ ok: true; abs: string } | { ok: false; reason: string }> {
  const contained = await containPath(rootDir, targetPath);
  if (!contained.ok) return contained;

  const rootAbs = resolve(rootDir);
  const rel = contained.abs === rootAbs ? "" : relative(rootAbs, contained.abs);
  const denied = isWriteDenied(rel);
  if (denied.denied) {
    return { ok: false, reason: denied.reason ?? `"${targetPath}" is refused by the write denylist` };
  }
  return { ok: true, abs: contained.abs };
}
