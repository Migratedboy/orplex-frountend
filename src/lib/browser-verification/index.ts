/**
 * browser-verification/index.ts
 *
 * Antigravity-style browser verification loop:
 * 1. Launch dev server in background
 * 2. Wait for it to be ready
 * 3. Open Playwright headless browser
 * 4. Navigate to page
 * 5. Take screenshot
 * 6. Check console for errors
 * 7. Optionally record video
 * 8. Return structured results as artifacts
 */

import { spawn, ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";

// === Types ===

export interface VerifyOptions {
  /** Working directory containing the project */
  workDir: string;
  /** Dev server command (e.g., "npm run dev", "npx vite") */
  devCommand?: string;
  /** Port to start dev server on (default: 3000) */
  port?: number;
  /** URL path to navigate to (default: "/") */
  path?: string;
  /** Time to wait for server to start (ms, default: 30000) */
  startupTimeout?: number;
  /** Viewport width (default: 1280) */
  width?: number;
  /** Viewport height (default: 720) */
  height?: number;
  /** Whether to record video */
  recordVideo?: boolean;
  /** Time to wait after page load before screenshot (ms, default: 2000) */
  settleTime?: number;
  /** Extra scripts to run on page (e.g., scroll, click) */
  interactions?: Array<{ action: string; selector?: string; value?: string }>;
}

export interface VerifyResult {
  success: boolean;
  /** Screenshot file path (relative to workDir) */
  screenshotPath?: string;
  /** Video file path if recording was enabled */
  videoPath?: string;
  /** Console errors captured from the page */
  consoleErrors: string[];
  /** Console warnings */
  consoleWarnings: string[];
  /** Page title */
  pageTitle?: string;
  /** HTTP status code */
  httpStatus?: number;
  /** Error message if something went wrong */
  error?: string;
  /** Duration of the verification (ms) */
  durationMs: number;
  /** Artifacts to store */
  artifacts: Array<{
    kind: string;
    name: string;
    content: string;
    mediaType: string;
  }>;
}

// === Dev Server Management ===

async function waitForServer(
  port: number,
  timeoutMs: number,
  path: string = "/"
): Promise<boolean> {
  const start = Date.now();
  const url = `http://localhost:${port}${path}`;

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });
      if (res.status < 500) return true;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function startDevServer(
  command: string,
  workDir: string,
  port: number
): ChildProcess {
  const [cmd, ...args] = command.split(/\s+/);
  return spawn(cmd, args, {
    cwd: workDir,
    env: { ...process.env, PORT: String(port), BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
}

// === Playwright Verification (inline — no Playwright dep required for basic checks) ===

async function verifyWithPlaywright(
  url: string,
  options: {
    width: number;
    height: number;
    recordVideo: boolean;
    workDir: string;
    settleTime: number;
    interactions: VerifyOptions["interactions"];
  }
): Promise<{
  screenshotBuffer: Buffer;
  consoleErrors: string[];
  consoleWarnings: string[];
  pageTitle: string;
  httpStatus: number;
}> {
  // Dynamic import — Playwright is optional
  let chromium: any;
  try {
    chromium = (await import("playwright")).chromium;
  } catch {
    throw new Error(
      "Playwright is not installed. Run: npm install playwright"
    );
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    ...(options.recordVideo
      ? {
          recordVideo: {
            dir: join(options.workDir, ".orplex-video"),
            size: { width: options.width, height: options.height },
          },
        }
      : {}),
  });

  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];

  // Capture console output
  page.on("console", (msg: any) => {
    const text = msg.text();
    if (msg.type() === "error") consoleErrors.push(text);
    if (msg.type() === "warning") consoleWarnings.push(text);
  });

  // Capture page errors
  page.on("pageerror", (err: any) => {
    consoleErrors.push(`[PageError] ${err.message}`);
  });

  // Navigate
  const response = await page.goto(url, {
    waitUntil: "networkidle",
    timeout: 30000,
  });

  // Wait for page to settle
  await page.waitForTimeout(options.settleTime);

  // Execute interactions
  if (options.interactions) {
    for (const interaction of options.interactions) {
      try {
        switch (interaction.action) {
          case "click":
            if (interaction.selector) {
              await page.click(interaction.selector);
              await page.waitForTimeout(500);
            }
            break;
          case "scroll":
            await page.evaluate(() => window.scrollBy(0, 300));
            await page.waitForTimeout(500);
            break;
          case "type":
            if (interaction.selector && interaction.value) {
              await page.fill(interaction.selector, interaction.value);
            }
            break;
          case "wait":
            await page.waitForTimeout(
              parseInt(interaction.value || "1000", 10)
            );
            break;
        }
      } catch {
        // Ignore interaction errors — continue verification
      }
    }
  }

  // Take screenshot
  const screenshotBuffer = await page.screenshot({ fullPage: false });

  const pageTitle = await page.title();
  const httpStatus = response?.status() || 0;

  // Close
  await context.close();
  await browser.close();

  return {
    screenshotBuffer,
    consoleErrors,
    consoleWarnings,
    pageTitle,
    httpStatus,
  };
}

// === Main Verification Function ===

export async function verifyUI(
  options: VerifyOptions
): Promise<VerifyResult> {
  const startTime = Date.now();
  const workDir = options.workDir;
  const port = options.port || 3000;
  const devCommand = options.devCommand || "npm run dev";
  const pagePath = options.path || "/";
  const startupTimeout = options.startupTimeout || 30000;
  const width = options.width || 1280;
  const height = options.height || 720;
  const settleTime = options.settleTime || 2000;
  const interactions = options.interactions || [];

  // Create output directory
  const outputDir = join(workDir, ".orplex-verify");
  await mkdir(outputDir, { recursive: true });

  const runId = randomBytes(8).toString("hex");
  let serverProcess: ChildProcess | null = null;

  try {
    // 1. Start dev server
    serverProcess = startDevServer(devCommand, workDir, port);

    // Capture server output
    const serverLogs: string[] = [];
    serverProcess.stdout?.on("data", (data) =>
      serverLogs.push(data.toString().trim())
    );
    serverProcess.stderr?.on("data", (data) =>
      serverLogs.push(data.toString().trim())
    );

    // 2. Wait for server to be ready
    const serverReady = await waitForServer(port, startupTimeout, pagePath);
    if (!serverReady) {
      return {
        success: false,
        error: `Dev server failed to start within ${startupTimeout}ms on port ${port}`,
        consoleErrors: [],
        consoleWarnings: [],
        durationMs: Date.now() - startTime,
        artifacts: [],
      };
    }

    // 3. Verify with Playwright
    const url = `http://localhost:${port}${pagePath}`;
    let verifyResult;
    try {
      verifyResult = await verifyWithPlaywright(url, {
        width,
        height,
        recordVideo: options.recordVideo || false,
        workDir,
        settleTime,
        interactions,
      });
    } catch (err) {
      return {
        success: false,
        error: `Playwright verification failed: ${(err as Error).message}`,
        consoleErrors: [],
        consoleWarnings: [],
        durationMs: Date.now() - startTime,
        artifacts: [],
      };
    }

    // 4. Save screenshot
    const screenshotPath = join(
      outputDir,
      `screenshot-${runId}.png`
    );
    await writeFile(screenshotPath, verifyResult.screenshotBuffer);

    // 5. Build artifacts
    const artifacts: VerifyResult["artifacts"] = [];

    // Screenshot artifact
    artifacts.push({
      kind: "screenshot",
      name: `Screenshot: ${url}`,
      content: screenshotPath,
      mediaType: "image/png",
    });

    // Console check artifact
    if (
      verifyResult.consoleErrors.length > 0 ||
      verifyResult.consoleWarnings.length > 0
    ) {
      const consoleContent = [
        `URL: ${url}`,
        `Status: ${verifyResult.httpStatus}`,
        `Title: ${verifyResult.pageTitle}`,
        "",
        ...verifyResult.consoleErrors.map((e) => `[ERROR] ${e}`),
        ...verifyResult.consoleWarnings.map((w) => `[WARN] ${w}`),
      ].join("\n");

      artifacts.push({
        kind: "console_check",
        name: `Console Check: ${verifyResult.consoleErrors.length} errors, ${verifyResult.consoleWarnings.length} warnings`,
        content: consoleContent,
        mediaType: "text/plain",
      });
    }

    // Test results artifact
    const testResult = [
      `# Browser Verification Results`,
      ``,
      `**URL:** ${url}`,
      `**Status:** ${verifyResult.httpStatus}`,
      `**Title:** ${verifyResult.pageTitle}`,
      `**Console Errors:** ${verifyResult.consoleErrors.length}`,
      `**Console Warnings:** ${verifyResult.consoleWarnings.length}`,
      `**Duration:** ${Date.now() - startTime}ms`,
      ``,
      verifyResult.consoleErrors.length === 0
        ? "✅ No console errors"
        : `❌ ${verifyResult.consoleErrors.length} console error(s):\n${verifyResult.consoleErrors.map((e) => `  - ${e}`).join("\n")}`,
      "",
      verifyResult.consoleWarnings.length === 0
        ? "✅ No console warnings"
        : `⚠️ ${verifyResult.consoleWarnings.length} console warning(s):\n${verifyResult.consoleWarnings.map((w) => `  - ${w}`).join("\n")}`,
    ].join("\n");

    artifacts.push({
      kind: "test_output",
      name: `Browser Test: ${verifyResult.consoleErrors.length === 0 ? "PASS" : "FAIL"}`,
      content: testResult,
      mediaType: "text/markdown",
    });

    // 6. Stop dev server
    serverProcess.kill("SIGTERM");
    serverProcess = null;

    return {
      success: verifyResult.consoleErrors.length === 0,
      screenshotPath,
      consoleErrors: verifyResult.consoleErrors,
      consoleWarnings: verifyResult.consoleWarnings,
      pageTitle: verifyResult.pageTitle,
      httpStatus: verifyResult.httpStatus,
      durationMs: Date.now() - startTime,
      artifacts,
    };
  } catch (err) {
    // Cleanup
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
    }

    return {
      success: false,
      error: (err as Error).message,
      consoleErrors: [],
      consoleWarnings: [],
      durationMs: Date.now() - startTime,
      artifacts: [],
    };
  }
}

// === Quick Verify (no Playwright — just HTTP check) ===

export async function quickVerify(
  workDir: string,
  port: number = 3000,
  devCommand: string = "npm run dev"
): Promise<{
  serverStarted: boolean;
  httpOk: boolean;
  error?: string;
}> {
  let serverProcess: ChildProcess | null = null;

  try {
    serverProcess = startDevServer(devCommand, workDir, port);
    const ready = await waitForServer(port, 15000);

    serverProcess.kill("SIGTERM");

    if (!ready) {
      return { serverStarted: false, httpOk: false, error: "Server did not start" };
    }

    const res = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(5000),
    });

    return {
      serverStarted: true,
      httpOk: res.ok,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (err) {
    if (serverProcess) serverProcess.kill("SIGTERM");
    return {
      serverStarted: false,
      httpOk: false,
      error: (err as Error).message,
    };
  }
}
