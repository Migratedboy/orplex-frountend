import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

/**
 * GET /api/system/build — which build is answering on this port?
 *
 * The desktop shell must not load a window against a stale server: a zombie
 * Next process from a previous version answers the port probe but serves the
 * old UI, which is exactly how "I updated and nothing changed" happens. The
 * shell therefore compares this id with the `.next/BUILD_ID` of the bundle it
 * shipped with (electron/server-identity.ts).
 *
 * Deliberately unauthenticated and index-free: it runs before any session
 * exists, and it reveals nothing but a build hash the installer already put on
 * disk. Local-only route (proxy.ts) — a remote backend has no such notion.
 */
export async function GET(_request: NextRequest) {
  const candidates = [
    path.join(process.cwd(), ".next", "BUILD_ID"),
    path.join(process.cwd(), "BUILD_ID"),
  ];
  let buildId = process.env.ORPLEX_BUILD_ID ?? "";
  for (const file of candidates) {
    if (buildId) break;
    try {
      buildId = fs.readFileSync(file, "utf8").trim();
    } catch {
      /* try the next layout */
    }
  }
  return NextResponse.json(
    {
      buildId: buildId || "unknown",
      version: process.env.ORPLEX_APP_VERSION ?? process.env.npm_package_version ?? null,
      pid: process.pid,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
