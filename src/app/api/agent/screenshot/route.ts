import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { urlError } from "@/lib/ssrf-guard";

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    const { url } = body as { url?: unknown; width?: unknown; height?: unknown };

    // SSRF gate: http(s) only, no private/loopback/metadata hosts, no
    // file:// or other schemes (Playwright would happily render those and
    // hand the pixels back as base64).
    const blocked = urlError(url);
    if (blocked) {
      return NextResponse.json({ error: blocked }, { status: 400 });
    }

    // Viewport clamp: arbitrary dimensions (100000×100000, negatives) OOM
    // the renderer or 500 the launch. Finite ints in a sane band only.
    const num = (v: unknown, fallback: number) =>
      typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
    const width = Math.min(Math.max(num((body as { width?: unknown }).width, 1280), 320), 1920);
    const height = Math.min(Math.max(num((body as { height?: unknown }).height, 720), 240), 1080);

    // Try Playwright for screenshot
    let browser: { close(): Promise<void> } | null = null;
    try {
      const { chromium } = await import("playwright");
      const launched = await chromium.launch({ headless: true });
      browser = launched;
      const page = await launched.newPage({ viewport: { width, height } });

      await page.goto(url as string, { waitUntil: "networkidle", timeout: 15000 });
      const screenshot = await page.screenshot({ type: "png", fullPage: false });
      await launched.close();
      browser = null;

      return NextResponse.json({
        screenshot: screenshot.toString("base64"),
        width,
        height,
      });
    } catch (playwrightErr) {
      // Never leak the browser or its temp profile on failure.
      if (browser) await browser.close().catch(() => {});
      // Playwright not available — try puppeteer-core or return error
      return NextResponse.json({
        error: "Browser preview requires Playwright. Install with: npx playwright install chromium",
      }, { status: 503 });
    }
  } catch (err: any) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
