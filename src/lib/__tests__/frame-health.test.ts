/**
 * frame-health.test.ts — failure detection for the embedded browser iframe.
 * Covers the three-lane probe plan (same-origin internal HEAD, localhost TCP
 * probe, server-side external probe) and failure classification (offline,
 * unreachable) — including why external probes must not run in the browser
 * (CORS opacity).
 */
import {
  frameProbeTarget,
  classifyFrameFailure,
  FRAME_PROBE_TIMEOUT_MS,
} from "../frame-health";

describe("frameProbeTarget", () => {
  it("plans an internal probe for app-relative URLs", () => {
    const t = frameProbeTarget("/api/search-page?q=hi");
    expect(t?.kind).toBe("internal");
    expect(t?.url).toContain("/api/search-page?q=hi");
  });

  it("plans a localhost TCP probe for loopback URLs (any port)", () => {
    expect(frameProbeTarget("http://localhost:4321/dead-app")).toMatchObject({ kind: "localhost", port: 4321 });
    expect(frameProbeTarget("http://127.0.0.1:3000/")).toMatchObject({ kind: "localhost", port: 3000 });
    // Default ports
    expect(frameProbeTarget("http://localhost/x")).toMatchObject({ kind: "localhost", port: 80 });
    expect(frameProbeTarget("https://localhost:8443/x")).toMatchObject({ kind: "localhost", port: 8443 });
  });

  it("plans a server-side external probe for public URLs", () => {
    const t = frameProbeTarget("https://example.com/page?x=1");
    expect(t).toMatchObject({ kind: "external", url: "https://example.com/page?x=1" });
  });

  it("returns null for empty or unparseable URLs", () => {
    expect(frameProbeTarget("")).toBeNull();
    expect(frameProbeTarget("::::not a url::::")).toBeNull();
  });
});

describe("classifyFrameFailure", () => {
  it("reports offline before anything else when navigator.onLine is false", () => {
    const hadNavigator = typeof globalThis.navigator !== "undefined";
    const orig = hadNavigator ? globalThis.navigator : undefined;
    Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true, writable: true });
    try {
      const f = classifyFrameFailure("external");
      expect(f.kind).toBe("offline");
      expect(f.title).toMatch(/offline/i);
    } finally {
      if (hadNavigator && orig) Object.defineProperty(globalThis, "navigator", { value: orig, configurable: true, writable: true });
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });

  it("gives localhost failures the dev-server hint", () => {
    const f = classifyFrameFailure("localhost");
    expect(f.kind).toBe("unreachable");
    expect(f.hint).toMatch(/dev server|port/i);
  });

  it("gives external failures the server-down hint", () => {
    const f = classifyFrameFailure("external", "HTTP 502");
    expect(f.kind).toBe("unreachable");
    expect(f.title).toMatch(/can't be reached/i);
  });

  it("gives internal failures the app-page wording, with detail when present", () => {
    const withDetail = classifyFrameFailure("internal", "HTTP 502");
    expect(withDetail.title).toMatch(/app page/i);
    expect(withDetail.hint).toContain("HTTP 502");
    const without = classifyFrameFailure("internal");
    expect(without.title).toMatch(/app page/i);
  });

  it("keeps a bounded probe timeout", () => {
    expect(FRAME_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});
