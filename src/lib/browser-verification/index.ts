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
import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

// === Types ===

export interface VerifyOptions {
  /** Working directory containing the project */
  workDir: string;
  /** Dev server command (e.g., "npm run dev", "npx vite") */
  devCommand?: string;
  /** Port to start dev server on (default: 5000) */
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
  /**
   * URL allow/denylists for agent-driven navigation during verification.
   * A default deny for private/link-local hosts is ALWAYS applied on top
   * (except the dev server itself) so a compromised page can't make the
   * agent probe the LAN or cloud metadata endpoints.
   */
  urlPolicy?: { allow?: string[]; deny?: string[] };
  /** Browser channel: bundled Chromium (default) or the installed Chrome. */
  browser?: "chromium" | "chrome";
}

// === URL policy (allowlist/denylist + private-host guard) ===

/** Hosts an agent-driven page may never reach, even without an explicit denylist. */
const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^169\.254\./, // link-local incl. cloud metadata (169.254.169.254)
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10
  /^192\.168\./, // RFC1918
  /^10\./, // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918
  /^::1$/, // IPv6 loopback
  /^fc|^fd/i, // IPv6 unique-local
];

export interface UrlPolicyResult {
  allowed: boolean;
  reason?: string;
}

// Installed-Chrome detection (cached): lets verification run in the user's
// REAL browser when present — genuine fingerprints, fewer bot walls, renders
// exactly like the user's own Chrome. Playwright's `channel: "chrome"` needs
// no path; the executable check just avoids trying when it isn't installed.
let _chromeDetection: Promise<boolean> | null = null;
export function isInstalledChromeAvailable(): Promise<boolean> {
  if (!_chromeDetection) {
    _chromeDetection = (async () => {
      try {
        const { existsSync } = await import("fs");
        const candidates =
          process.platform === "win32"
            ? [
                "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
                "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
                `${process.env.LOCALAPPDATA || ""}\\Google\\Chrome\\Application\\chrome.exe`,
              ]
            : process.platform === "darwin"
              ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
              : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser"];
        return candidates.some((p) => p && existsSync(p));
      } catch {
        return false;
      }
    })();
  }
  return _chromeDetection;
}

/**
 * Decide whether `url` may be loaded during verification. Order: explicit
 * deny → explicit allow → default private-host guard (localhost on any port
 * and public hosts pass; other loopback/private/metadata hosts fail).
 */
export function checkUrlPolicy(
  rawUrl: string,
  policy?: { allow?: string[]; deny?: string[] }
): UrlPolicyResult {
  let host = "";
  let normalized = "";
  try {
    const u = new URL(rawUrl);
    // URL.hostname keeps IPv6 literals bracketed — strip for matching
    host = u.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
    normalized = `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return { allowed: false, reason: "unparseable URL" };
  }

  const matches = (list: string[] | undefined, what: string): boolean => {
    if (!list) return false;
    return list.some((entry) => {
      const e = entry.toLowerCase();
      return host === e || host.endsWith(`.${e}`) || normalized.toLowerCase().startsWith(e);
    });
  };

  if (matches(policy?.deny, "deny")) {
    return { allowed: false, reason: "denied by urlPolicy.deny" };
  }
  if (matches(policy?.allow, "allow")) {
    return { allowed: true };
  }

  const isLoopback = host === "localhost" || host === "127.0.0.1";
  if (isLoopback) return { allowed: true }; // the dev server itself lives here
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(host))) {
    return { allowed: false, reason: `private/link-local host blocked: ${host}` };
  }
  return { allowed: true };
}

/** Ordered record of what the verification session actually did. */
export interface VerifyStep {
  action: string;
  detail?: string;
  screenshotPath?: string;
  consoleErrorsAtStep: number;
  atMs: number;
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
  /** Ordered timeline of what the session did (navigate → interactions → screenshot) */
  timeline?: VerifyStep[];
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
  path: string = "/",
  processHandle?: ChildProcess | null
): Promise<boolean> {
  const start = Date.now();
  const url = `http://localhost:${port}${path}`;

  while (Date.now() - start < timeoutMs) {
    // If the dev server process died, don't keep polling — fail fast
    if (
      processHandle &&
      processHandle.exitCode !== null &&
      processHandle.exitCode !== undefined
    ) {
      return false;
    }

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

interface PlaywrightOutcome {
  screenshotBuffer: Buffer;
  consoleErrors: string[];
  consoleWarnings: string[];
  pageTitle: string;
  httpStatus: number;
  videoPath?: string;
}

async function verifyWithPlaywright(
  url: string,
  options: {
    width: number;
    height: number;
    recordVideo: boolean;
    workDir: string;
    settleTime: number;
    interactions: VerifyOptions["interactions"];
    urlPolicy?: VerifyOptions["urlPolicy"];
    browser?: VerifyOptions["browser"];
    screenshotDir: string;
    runId: string;
  }
): Promise<PlaywrightOutcome & { timeline: VerifyStep[] }> {
  // Dynamic import — Playwright is optional
  let chromium: any;
  try {
    chromium = (await import("playwright")).chromium;
  } catch {
    throw new Error(
      "Playwright is not installed. Run: npm install playwright"
    );
  }

  const videoDir = join(options.workDir, ".orplex-video");
  // Isolated ephemeral profile — never the user's real browser profile.
  // Bundled Chromium uses a fresh temp profile per launch (inherently
  // isolated); installed Chrome gets a dedicated throwaway userDataDir via
  // launchPersistentContext so cookies/extensions/history can't leak in.
  const profileDir = join(options.workDir, ".orplex-verify", `profile-${options.runId}`);
  const useChrome = options.browser === "chrome";
  let browser: any = null;
  const timeline: VerifyStep[] = [];
  const t0 = Date.now();

  const newContext = async (): Promise<any> => {
    const contextOpts: any = {
      viewport: { width: options.width, height: options.height },
      ...(options.recordVideo
        ? {
            recordVideo: {
              dir: videoDir,
              size: { width: options.width, height: options.height },
            },
          }
        : {}),
    };
    if (useChrome) {
      await mkdir(profileDir, { recursive: true });
      return chromium.launchPersistentContext(profileDir, {
        headless: true,
        channel: "chrome",
        ...contextOpts,
      });
    }
    browser = await chromium.launch({ headless: true });
    return browser.newContext(contextOpts);
  };

  let context: any;
  try {
    context = await newContext();

    // Enforce the URL policy on EVERY request (navigation + subresources):
    // denied/privately-targeted requests are aborted client-side so a page
    // can't make the agent's browser probe the LAN or metadata endpoints.
    await context.route("**/*", (route: any) => {
      const verdict = checkUrlPolicy(route.request().url(), options.urlPolicy);
      if (verdict.allowed) return route.continue();
      return route.abort("blockedbyclient");
    });

    try {
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

      // Navigate (pre-checked — a disallowed target fails fast with a clear
      // reason instead of a confusing route-abort error mid-load)
      const navVerdict = checkUrlPolicy(url, options.urlPolicy);
      if (!navVerdict.allowed) {
        throw new Error(`Verification target blocked by URL policy: ${navVerdict.reason}`);
      }
      const response = await page.goto(url, {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      // Execute interactions. Every step is recorded AND framed (best-effort
      // screenshot) so the walkthrough replay shows one image per action —
      // not just the final screenshot.
      const recordStep = async (action: string, detail?: string) => {
        const entry: VerifyStep = { action, detail, consoleErrorsAtStep: consoleErrors.length, atMs: Date.now() - t0 };
        try {
          const frameBuf = await page.screenshot({ fullPage: false });
          const framePath = join(options.screenshotDir, `step-${timeline.length + 1}-${options.runId}.png`);
          await writeFile(framePath, frameBuf);
          entry.screenshotPath = framePath;
        } catch {
          // frame capture is best-effort; the step is still recorded
        }
        timeline.push(entry);
      };

      // Frame the initial navigation — the replay's first image.
      await recordStep("navigate", url);

      // Wait for page to settle, then frame the loaded page.
      await page.waitForTimeout(options.settleTime);
      await recordStep("loaded");

      if (options.interactions) {
        for (const interaction of options.interactions) {
          try {
            switch (interaction.action) {
              case "click":
                if (interaction.selector) {
                  await page.click(interaction.selector);
                  await page.waitForTimeout(500);
                  await recordStep("click", interaction.selector);
                }
                break;
              case "scroll":
                await page.evaluate(() => window.scrollBy(0, 300));
                await page.waitForTimeout(500);
                await recordStep("scroll");
                break;
              case "type":
                if (interaction.selector && interaction.value) {
                  await page.fill(interaction.selector, interaction.value);
                  await recordStep("type", `${interaction.selector} = "${interaction.value}"`);
                }
                break;
              case "wait":
                await page.waitForTimeout(
                  parseInt(interaction.value || "1000", 10)
                );
                await recordStep("wait", interaction.value || "1000");
                break;
            }
          } catch {
            // Ignore interaction errors — continue verification
          }
        }
      }

      // Take screenshot
      const screenshotBuffer = await page.screenshot({ fullPage: false });
      // Per-step screenshot for the timeline view (best-effort)
      const stepShotPath = join(options.screenshotDir, `step-${timeline.length + 1}-${options.runId}.png`);
      try {
        await writeFile(stepShotPath, screenshotBuffer);
        timeline.push({ action: "screenshot", detail: stepShotPath, screenshotPath: stepShotPath, consoleErrorsAtStep: consoleErrors.length, atMs: Date.now() - t0 });
      } catch {
        timeline.push({ action: "screenshot", consoleErrorsAtStep: consoleErrors.length, atMs: Date.now() - t0 });
      }

      const pageTitle = await page.title();
      const httpStatus = response?.status() || 0;

      // Video is only flushed to disk when the context closes
      let videoPath: string | undefined;
      if (options.recordVideo) {
        try {
          const video = page.video();
          if (video) {
            await context.close();
            videoPath = (await video.path()) || undefined;
          }
        } catch {
          // Video recording failed — verification continues without it
        }
      }

      if (videoPath === undefined) {
        await context.close();
      }

      return {
        screenshotBuffer,
        consoleErrors,
        consoleWarnings,
        pageTitle,
        httpStatus,
        videoPath,
        timeline,
      };
    } catch (err) {
      // Any failure — make sure the context/browser are closed, then rethrow
      try {
        await context.close();
      } catch {}
      throw err;
    }
  } finally {
    // Guaranteed teardown even if newContext threw — closing the context
    // also tears down the persistent (chrome-channel) browser process.
    try {
      await context?.close();
    } catch {}
    try {
      await browser?.close();
    } catch {}
  }
}

// === Process cleanup helpers ===

function killTree(proc: ChildProcess | null, force = false) {
  if (!proc || proc.killed) return;
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    proc.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // Already dead
  }
}

/** SIGTERM now, SIGKILL after a grace period (Windows ignores SIGTERM) */
function scheduleHardKill(proc: ChildProcess | null, delayMs = 4000) {
  if (!proc) return;
  const timer = setTimeout(() => {
    killTree(proc, true);
  }, delayMs);
  timer.unref?.();
}

/** Collect up to a cap of lines, dropping the middle of over-long output */
function pushLogLine(logs: string[], line: string, cap = 200) {
  if (logs.length >= cap) {
    // Keep first half and last quarter, drop the middle
    const keepFirst = Math.floor(cap * 0.6);
    const keepLast = Math.floor(cap * 0.25);
    const kept = [
      ...logs.slice(0, keepFirst),
      `... ${logs.length - keepFirst - keepLast} lines truncated ...`,
      ...logs.slice(logs.length - keepLast),
    ];
    logs.length = 0;
    logs.push(...kept);
    return;
  }
  logs.push(line);
}

// === Main Verification Function ===

export async function verifyUI(
  options: VerifyOptions
): Promise<VerifyResult> {
  const startTime = Date.now();
  const workDir = options.workDir;
  const port = options.port || 5000;
  const devCommand = options.devCommand || "npm run dev";
  const pagePath = options.path || "/";
  const startupTimeout = options.startupTimeout || 30000;
  const width = options.width || 1280;
  const height = options.height || 720;
  const settleTime = options.settleTime || 2000;
  const interactions = options.interactions || [];

  // === WORKSPACE-BOUNDARY GUARD (LIVE-VALIDATED Orplex corruption) ===
  // The default devCommand "npm run dev" inside a folder WITHOUT its own
  // package.json makes npm walk UP the directory tree to the nearest
  // package.json — which can be Orplex itself. The model's own app then
  // never boots; instead a second Next/Turbopack instance races the live
  // server for its port and corrupts module state — surfaced to the agent
  // as if ITS app failed (Turbopack `__TURBOPACK__imported__module__...`).
  // Refuse early with an actionable message instead.
  if (devCommand.includes("npm run") && !existsSync(join(workDir, "package.json"))) {
    return {
      success: false,
      error: "infrastructure-failure: the workspace has no package.json, so `npm run dev` would run from the NEAREST parent package.json (possibly the Orplex app itself) instead of your project. Start the correct server instead — static site: `npx serve . -l <port>` · Python: `python -m http.server <port>` · then re-run verify_app with that dev_command and port.",
      consoleErrors: [],
      consoleWarnings: [],
      durationMs: Date.now() - startTime,
      timeline: [],
      artifacts: [],
    };
  }

  // Create output directory
  const outputDir = join(workDir, ".orplex-verify");
  await mkdir(outputDir, { recursive: true });

  const runId = randomBytes(8).toString("hex");
  const serverLogs: string[] = [];
  let serverProcess: ChildProcess | null = null;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (serverProcess) {
      killTree(serverProcess);
      scheduleHardKill(serverProcess);
    }
  };

  try {
    // 1. Start dev server
    serverProcess = startDevServer(devCommand, workDir, port);
    serverProcess.once("error", (err) => {
      serverLogs.push(`[spawn error] ${err.message}`);
    });

    // Capture server output (capped — dev servers can be very chatty)
    serverProcess.stdout?.on("data", (data) =>
      pushLogLine(serverLogs, data.toString().trim())
    );
    serverProcess.stderr?.on("data", (data) =>
      pushLogLine(serverLogs, data.toString().trim())
    );

    // 2. Wait for server to be ready
    const serverReady = await waitForServer(
      port,
      startupTimeout,
      pagePath,
      serverProcess
    );
    if (!serverReady) {
      const tail = serverLogs.slice(-30).join("\n");
      return {
        success: false,
        error: `Dev server failed to start within ${startupTimeout}ms on port ${port}. Logs:\n${tail}`,
        consoleErrors: [],
        consoleWarnings: [],
        durationMs: Date.now() - startTime,
        timeline: [],
        artifacts: [],
      };
    }

    // 3. Verify with Playwright
    const url = `http://localhost:${port}${pagePath}`;
    let verifyResult: PlaywrightOutcome & { timeline: VerifyStep[] };
    try {
      verifyResult = await verifyWithPlaywright(url, {
        width,
        height,
        recordVideo: options.recordVideo || false,
        workDir,
        settleTime,
        interactions,
        urlPolicy: options.urlPolicy,
        browser: options.browser,
        screenshotDir: outputDir,
        runId,
      });
    } catch (err) {
      return {
        success: false,
        error: `Playwright verification failed: ${(err as Error).message}`,
        consoleErrors: [],
        consoleWarnings: [],
        durationMs: Date.now() - startTime,
        timeline: [],
        artifacts: [],
      };
    }

    // 4. Save screenshot
    const screenshotPath = join(outputDir, `screenshot-${runId}.png`);
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

    // Video artifact (path only — stored relative to workDir)
    let videoPath: string | undefined;
    if (verifyResult.videoPath) {
      videoPath = verifyResult.videoPath;
      artifacts.push({
        kind: "video",
        name: `Browser Recording: ${url}`,
        content: verifyResult.videoPath,
        mediaType: "video/webm",
      });
    }

    // Walkthrough artifact — the replayable step-by-step record. One frame
    // per step where capture succeeded; frame paths point at files under
    // workDir (durable when workDir is the user's workspace; the server
    // executor copies frames out before its worktrees are deleted).
    if (verifyResult.timeline && verifyResult.timeline.length > 0) {
      const { buildWalkthrough } = await import("@/lib/walkthrough");
      const wt = buildWalkthrough({
        timeline: verifyResult.timeline,
        success: verifyResult.consoleErrors.length === 0,
        url,
        pageTitle: verifyResult.pageTitle,
        httpStatus: verifyResult.httpStatus,
        durationMs: Date.now() - startTime,
        consoleErrors: verifyResult.consoleErrors,
        consoleWarnings: verifyResult.consoleWarnings,
      });
      artifacts.push({
        kind: "walkthrough",
        name: `Walkthrough: ${url}`,
        content: JSON.stringify(wt),
        mediaType: "application/json",
      });
    }

    // Timeline artifact (ordered steps + per-step console error counts)
    const timeline = verifyResult.timeline;
    if (timeline.length > 0) {
      artifacts.push({
        kind: "timeline",
        name: `Timeline: ${timeline.length} step(s)`,
        content: JSON.stringify({ url, steps: timeline }, null, 2),
        mediaType: "application/json",
      });
    }

    return {
      success: verifyResult.consoleErrors.length === 0,
      screenshotPath,
      videoPath,
      consoleErrors: verifyResult.consoleErrors,
      consoleWarnings: verifyResult.consoleWarnings,
      pageTitle: verifyResult.pageTitle,
      httpStatus: verifyResult.httpStatus,
      durationMs: Date.now() - startTime,
      timeline,
      artifacts,
    };
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message,
      consoleErrors: [],
      consoleWarnings: [],
      durationMs: Date.now() - startTime,
      timeline: [],
      artifacts: [],
    };
  } finally {
    cleanup();
  }
}

// === Quick Verify (no Playwright — just HTTP check) ===

export async function quickVerify(
  workDir: string,
  port: number = 5000,
  devCommand: string = "npm run dev"
): Promise<{
  serverStarted: boolean;
  httpOk: boolean;
  error?: string;
}> {
  let serverProcess: ChildProcess | null = null;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (serverProcess) {
      killTree(serverProcess);
      scheduleHardKill(serverProcess);
    }
  };

  try {
    serverProcess = startDevServer(devCommand, workDir, port);
    const ready = await waitForServer(port, 15000, "/", serverProcess);

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
    return {
      serverStarted: false,
      httpOk: false,
      error: (err as Error).message,
    };
  } finally {
    cleanup();
  }
}
