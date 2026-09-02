import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { url, width = 1280, height = 720 } = body;

    if (!url) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    // Try Playwright for screenshot
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width, height } });

      await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
      const screenshot = await page.screenshot({ type: "png", fullPage: false });
      await browser.close();

      return NextResponse.json({
        screenshot: screenshot.toString("base64"),
        width,
        height,
      });
    } catch (playwrightErr) {
      // Playwright not available — try puppeteer-core or return error
      return NextResponse.json({
        error: "Browser preview requires Playwright. Install with: npx playwright install chromium",
        detail: (playwrightErr as Error).message,
      }, { status: 503 });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
