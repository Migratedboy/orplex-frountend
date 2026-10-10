// app-version.ts — tiny semver compare + app version resolution for the
// backend/frontend version handshake. No deps, Edge-safe (proxy.ts imports it).

/** Parse "1.2.3" (tolerates "v" prefix, pre-release suffix, missing parts). */
export function parseVersion(v: string): [number, number, number] {
  const clean = v.trim().replace(/^v/i, "").split(/[+-]/)[0];
  const parts = clean.split(".").map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** True when `v` is at least `min` (major.minor.patch numeric compare). */
export function meetsMinimum(v: string, min: string): boolean {
  const [a, b, c] = parseVersion(v);
  const [x, y, z] = parseVersion(min);
  if (a !== x) return a > x;
  if (b !== y) return b > y;
  return c >= z;
}

/** Packaged app version. Falls back to "unknown" (never throws). */
export function appVersion(): string {
  try {
    const pkg = require("../../package.json") as { version?: string };
    if (pkg?.version) return pkg.version;
  } catch {
    /* bundled without package.json access */
  }
  return process.env.npm_package_version || "unknown";
}
