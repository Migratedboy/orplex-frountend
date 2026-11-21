/**
 * electron/server-identity.ts — prove that the server the window loads is the
 * bundle that shipped with this installer.
 *
 * Why this exists: the app talks to its own Next server over loopback on a
 * fixed port, and it decides "is a server already up?" by probing that port.
 * A zombie server from a previous build (window closed by a crash, a child that
 * outlived taskkill, an install that could not replace a locked file) answers
 * that probe too. The window then loads OLD UI while `app.getVersion()` reports
 * the NEW version — the "it updated but nothing changed" report.
 *
 * The fix is an identity check instead of a liveness check: Next writes a
 * `.next/BUILD_ID` next to the standalone server, and the bundle serves it from
 * /api/system/build. Same id on both sides means the responder is our build.
 *
 * Pure-ish on purpose (no Electron import) so it can be unit tested with node.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

/** Where the bundled server publishes its build id. */
export const BUILD_PROBE_PATH = "/api/system/build";

export interface ServerBuild {
  buildId: string;
  version?: string;
}

/** Read the BUILD_ID that belongs to a standalone bundle on disk. */
export function readBuildId(standaloneDir: string): string | null {
  const candidates = [
    path.join(standaloneDir, ".next", "BUILD_ID"),
    // A hand-built/flat layout keeps .next beside server.js.
    path.join(standaloneDir, "BUILD_ID"),
  ];
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, "utf8").trim();
      if (raw) return raw;
    } catch {
      /* try the next layout */
    }
  }
  return null;
}

/** Parse the probe body. Anything unparseable is "no answer", not a match. */
export function parseBuildPayload(raw: string): ServerBuild | null {
  try {
    const parsed = JSON.parse(raw) as { buildId?: unknown; version?: unknown };
    if (typeof parsed.buildId !== "string" || !parsed.buildId) return null;
    return {
      buildId: parsed.buildId,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Does the answering server belong to this install?
 *
 * Unknown expected id (a bundle built without .next/BUILD_ID) cannot be proven
 * either way, so it is accepted: refusing to start would brick a working
 * install over a missing file.
 */
export function buildMatches(expected: string | null, actual: string | null): boolean {
  if (!expected) return true;
  return actual === expected;
}

/** GET /api/system/build once. Null when the port answers nothing we understand. */
export function fetchServerBuild(baseUrl: string, timeoutMs = 2000): Promise<ServerBuild | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: ServerBuild | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const req = http.get(new URL(BUILD_PROBE_PATH, baseUrl), (res) => {
      if (!res.statusCode || res.statusCode >= 300) {
        res.resume();
        done(null);
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 4096) req.destroy();
      });
      res.on("end", () => done(parseBuildPayload(body)));
      res.on("error", () => done(null));
    });
    req.on("error", () => done(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done(null);
    });
  });
}

/**
 * Wait until the server on `baseUrl` answers with `expectedBuildId`.
 *
 * Returns the identity it finally saw (or null) so the caller can tell
 * "answered, but from a different build" apart from "never answered".
 */
export async function waitForMatchingBuild(
  baseUrl: string,
  expectedBuildId: string | null,
  timeoutMs = 20_000,
  intervalMs = 400
): Promise<{ ok: boolean; seen: ServerBuild | null }> {
  const started = Date.now();
  let seen: ServerBuild | null = null;
  for (;;) {
    const build = await fetchServerBuild(baseUrl);
    if (build) {
      seen = build;
      if (buildMatches(expectedBuildId, build.buildId)) return { ok: true, seen };
    }
    if (Date.now() - started >= timeoutMs) return { ok: false, seen };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
