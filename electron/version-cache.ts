/**
 * electron/version-cache.ts — drop the renderer's HTTP cache across an update.
 *
 * Second half of the "updated but nothing changed" bug. The window loads
 * http://127.0.0.1:<port>/… and Chromium caches that origin like any website:
 * hashed chunks are immutable by design, so after an update the new HTML can
 * still pull framework chunks the disk cache kept from the previous build. The
 * result looks like a half-applied release — some screens new, some stale, and
 * a hard reload (Ctrl+Shift+R) fixes it, which is exactly how users report it.
 *
 * The version marker makes this a one-shot: clear once per installed version,
 * not on every boot (a cold cache on every launch costs real startup time).
 *
 * No Electron import — the clear callback is injected, so this is unit tested
 * against a temp dir instead of a live session.
 */
import fs from "node:fs";
import path from "node:path";

export interface VersionMarker {
  version: string;
  clearedAt: string;
}

function markerPath(userDataDir: string): string {
  return path.join(userDataDir, "cache-version.json");
}

/** What version last cleared the cache? Null when unreadable/missing. */
export function readCachedVersion(userDataDir: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath(userDataDir), "utf8")) as Partial<VersionMarker>;
    return typeof parsed.version === "string" && parsed.version ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Record the version whose cache has been cleared. Never throws. */
export function writeCachedVersion(userDataDir: string, version: string, now = new Date()): void {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    const marker: VersionMarker = { version, clearedAt: now.toISOString() };
    fs.writeFileSync(markerPath(userDataDir), JSON.stringify(marker), "utf8");
  } catch {
    /* a failed marker costs one extra clean, never a broken boot */
  }
}

/**
 * Clear caches iff the running version differs from the last one that cleared.
 * Returns true when a clear actually happened (logged by the caller).
 */
export async function clearCachesOnVersionChange(options: {
  userDataDir: string;
  version: string;
  clear: () => Promise<void>;
  now?: Date;
}): Promise<boolean> {
  const previous = readCachedVersion(options.userDataDir);
  if (previous === options.version) return false;
  try {
    await options.clear();
  } catch {
    return false;
  }
  writeCachedVersion(options.userDataDir, options.version, options.now);
  return true;
}
