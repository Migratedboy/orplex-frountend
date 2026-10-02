// agent-browser-session.test.ts — Unit tests for the shared browser-session
// manager behind the browser_* tools. Runs without Playwright installed: the
// module must fail gracefully with an actionable error when no browser can
// launch, and policy/validation must fire before any session is created.
import { runBrowserOp, activeSessionCount } from "../agent-browser-session";

jest.mock("@/lib/browser-verification", () => ({
  ...jest.requireActual("@/lib/browser-verification"),
  isInstalledChromeAvailable: jest.fn().mockResolvedValue(false),
}));

describe("agent-browser-session", () => {
  afterEach(async () => {
    await runBrowserOp("test-user", "close").catch(() => {});
  });

  it("rejects unknown ops before creating any session", async () => {
    const res = await runBrowserOp("test-user", "curl", { url: "http://localhost:3000" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("unknown op");
    expect(activeSessionCount()).toBe(0);
  });

  it("blocks SSRF-hosted URLs before creating any session", async () => {
    const res = await runBrowserOp("test-user", "navigate", { url: "http://169.254.169.254/latest/meta-data" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("blocked by URL policy");
    expect(activeSessionCount()).toBe(0);
  });

  it("returns an actionable error when no browser backend is available", async () => {
    const res = await runBrowserOp("test-user", "read");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/playwright|browser/i);
    expect(activeSessionCount()).toBe(0);
  });
});
