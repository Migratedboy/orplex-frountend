import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { checkBurstLimit } from "@/lib/rate-limiter";
import { runBrowserOp } from "@/lib/agent-browser-session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/agent/browser — subsystem health probe (no browser launch).
 *
 * Reports whether the Playwright chromium package is INTACT in this
 * deployment. `browsers.json` lives inside playwright-core; serverless
 * bundlers sometimes strip non-.js files from the package, which breaks
 * every launch with "Cannot find module .../browsers.json". Surfacing that
 * here turns an invisible runtime failure into a one-request diagnosis.
 *
 * Auth: same session gate as POST — never expose infra details publicly.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
  }

  let chromium = false;
  let binary = false;
  let error: string | null = null;
  try {
    // 1) Registry intact? browsers.json lives inside playwright-core;
    // serverless bundlers sometimes strip non-.js files from the package.
    const pkgPath = require.resolve("playwright-core/browsers.json");
    const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { browsers?: unknown[] };
    chromium = Array.isArray(parsed.browsers) && parsed.browsers.length > 0;
    if (!chromium) error = "browsers.json parsed but contains no browser entries";
    // 2) Browser binary actually present? (registry may be intact while the
       // downloaded browsers were never installed / pruned by the bundler)
    if (chromium) {
      const { chromium: pwChromium } = await import("playwright");
      const exe = (pwChromium as unknown as { executablePath(): string }).executablePath();
      binary = fs.existsSync(exe);
      if (!binary) error = `chromium binary missing at ${exe}`;
    }
  } catch (err) {
    error = (err as Error).message.slice(0, 300);
  }

  return NextResponse.json({ ok: true, chromium, binary, error });
}

/**
 * POST /api/agent/browser — Server-backed browser_* tools.
 *
 * Body: { op, url?, selector?, ref?, text?, value?, key?, dx?, dy?, time?,
 *         timeoutMs?, role?, action?, index?, fullPage?, viewpoint?, code?, sessionId? }
 * Same result shapes the Electron agent-browser bridge produces, so the
 * model sees one identical tool contract whether the browser lives in the
 * desktop shell or on the server. Navigation is SSRF-guarded server-side;
 * sessions are per-user with caps and idle reaping (see agent-browser-session).
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
  }

  if (!(await checkBurstLimit(session.user.id).catch(() => false))) {
    return NextResponse.json({ ok: false, error: "Too many requests. Try again in about a minute." }, { status: 429, headers: { "Retry-After": "60" } });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body.op !== "string") {
    return NextResponse.json({ ok: false, error: "op required" }, { status: 400 });
  }

  const result = await runBrowserOp(session.user.id, body.op, {
    url: typeof body.url === "string" ? body.url : undefined,
    selector: typeof body.selector === "string" ? body.selector : undefined,
    ref: typeof body.ref === "string" ? body.ref : undefined,
    text: typeof body.text === "string" ? body.text : undefined,
    value: typeof body.value === "string" ? body.value : undefined,
    key: typeof body.key === "string" ? body.key : undefined,
    dx: typeof body.dx === "number" ? body.dx : undefined,
    dy: typeof body.dy === "number" ? body.dy : undefined,
    time: typeof body.time === "number" ? body.time : undefined,
    timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
    role: typeof body.role === "string" ? body.role : undefined,
    tabAction: typeof body.action === "string" ? body.action : undefined,
    index: typeof body.index === "number" ? body.index : undefined,
    fullPage: typeof body.fullPage === "boolean" ? body.fullPage : undefined,
    viewpoint: typeof body.viewpoint === "string" ? body.viewpoint : undefined,
    code: typeof body.code === "string" ? body.code : undefined,
    sessionId: typeof body.sessionId === "string" ? body.sessionId.slice(0, 64) : undefined,
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
