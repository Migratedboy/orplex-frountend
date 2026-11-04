// package-allowlist.ts — what the desktop installer is allowed to contain.
//
// The bug this exists for: Next.js file tracing (Turbopack) copies the WHOLE
// project into `.next/standalone` when a route handler touches the filesystem
// with a dynamic path — the build prints "Dynamic filesystem access causes
// tracing of the whole project" 18 times. The desktop staging step then
// shipped that tree verbatim, so the installer contained:
//
//   - the repo's `.env`  — DATABASE_URL and the provider API keys. electron/main.ts
//     documents the opposite intent ("A PACKAGED app has no .env beside it …
//     it holds the database password"), so this was a shipped secret.
//   - the PREVIOUS release installer (1 GB) and its 7z archive (550 MB), because
//     `release/` is part of the project root that got traced.
//   - a full duplicate Electron runtime (556 MB) — including the STOCK
//     electron.exe, which is the very binary the taskbar icon poison installs.
//   - the coverage report, the docs site, the source tree and local logs.
//
// The payload reached 3.3 GB and the NSIS packer then failed outright:
// "failed creating mmap of …nsis.7z" — makensis is a 32-bit process and cannot
// map a file larger than 2 GB. So the same root cause both leaked secrets AND
// broke the release build.
//
// The fix is an explicit allowlist: the packaged app contains the server it
// runs and the dependencies that server loads — and nothing else. Everything
// in this module is pure so it can be unit-tested without a filesystem.

/** Top-level entries of `.next/standalone` that the packaged app actually runs. */
export const SHIPPABLE_STANDALONE_ENTRIES: readonly string[] = [
  // The standalone server entry point (required-server-files + .next chunks).
  "server.js",
  // The standalone package manifest (its `type`/deps shape).
  "package.json",
  // The compiled server, the hashed client assets and the build manifests.
  ".next",
  // Favicon, icons and the vendored fonts the UI requests at runtime.
  "public",
  // The traced production dependencies the server requires.
  "node_modules",
  // The Prisma schema (tiny, no secrets — the datasource URL is an env var).
  "prisma",
];

/**
 * `node_modules` entries that must never ship.
 *
 * `electron` is the desktop app's own runtime: the packaged executable IS
 * electron.exe, so a second copy inside the app is 556 MB of duplicated
 * runtime — and it carries the STOCK electron.exe, the binary that creates the
 * Start Menu shortcut which poisons the Windows taskbar identity (BUG-008).
 */
export const PRUNED_NODE_MODULES: readonly string[] = ["electron"];

/**
 * Orphaned `prisma generate` temp files.
 *
 * `prisma generate` writes `query_engine-windows.dll.node.tmp<pid>` and
 * renames it into place. An interrupted generate leaves the temp file behind;
 * fourteen of them were sitting in the client folder (14 × 18.4 MB = 257 MB)
 * and every one of them was copied into the installer.
 */
export function isPrismaEngineTempFile(name: string): boolean {
  return /\.tmp\d+$/.test(name);
}

/**
 * File names that must never appear in a shipped package.
 *
 * Deliberately precise — a false positive here fails the release build, so
 * the patterns match secret FILES, not files that merely talk about secrets
 * (the compiled `secret-scanner-plugin` chunk is a legitimate part of the app
 * and must keep shipping).
 *
 * @param insideNodeModules third-party package content: only `.env*` is
 *   treated as a leak there, because a dependency's own fixtures are not our
 *   leak and must not be able to break the build.
 */
export function isLeakFileName(name: string, insideNodeModules = false): boolean {
  if (/^\.env(\..+)?$/i.test(name)) return true;
  if (insideNodeModules) return false;
  if (/super[_-]?secret/i.test(name)) return true;
  if (/\.(pem|p12|pfx|key)$/i.test(name)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/i.test(name)) return true;
  return false;
}

/** Split a list of names into the ones to keep and the ones to drop. */
export function partitionByDecision(
  entries: readonly string[],
  keep: (name: string) => boolean
): { keep: string[]; drop: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const entry of entries) {
    if (keep(entry)) kept.push(entry);
    else dropped.push(entry);
  }
  return { keep: kept, drop: dropped };
}

/** Decide which top-level `.next/standalone` entries survive. */
export function planStandalonePrune(entries: readonly string[]): { keep: string[]; drop: string[] } {
  const allow = new Set(SHIPPABLE_STANDALONE_ENTRIES);
  return partitionByDecision(entries, (name) => allow.has(name));
}

/** Decide which `.next/standalone/node_modules` entries survive. */
export function planNodeModulesPrune(entries: readonly string[]): { keep: string[]; drop: string[] } {
  const deny = new Set(PRUNED_NODE_MODULES);
  return partitionByDecision(entries, (name) => !deny.has(name));
}

/** Decide which `.prisma/client` files survive (the orphaned temp files go). */
export function planPrismaClientPrune(entries: readonly string[]): { keep: string[]; drop: string[] } {
  return partitionByDecision(entries, (name) => !isPrismaEngineTempFile(name));
}

/**
 * Find the files in a staged package that must never ship.
 *
 * @param relativePaths package-relative paths (forward slashes).
 */
export function findLeakFiles(relativePaths: readonly string[]): string[] {
  const leaks: string[] = [];
  for (const rel of relativePaths) {
    const normalized = rel.replace(/\\/g, "/");
    const name = normalized.slice(normalized.lastIndexOf("/") + 1);
    const insideNodeModules = normalized.includes("/node_modules/") || normalized.startsWith("node_modules/");
    if (isLeakFileName(name, insideNodeModules)) leaks.push(normalized);
  }
  return leaks;
}
