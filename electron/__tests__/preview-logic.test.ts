// preview-logic.test.ts — the pure decision helpers of the native preview /
// agent browser, extracted verbatim from electron/main.ts. These pins are the
// test plan for the preview extraction: URL normalization (address-bar
// semantics incl. the Google-search fallback), bounds clamping (no negative
// origins, never a 0-sized view), find-ref resolution (stale/unknown refs
// must error, never guess), console line formatting (Electron ≥32
// MessageDetails shape), and the find filter pipeline (cap 40).

import {
  AGENT_VIEWPORTS,
  clampFixedDelayMs,
  clampWaitTimeoutMs,
  computeBounds,
  filterFindMatches,
  formatConsoleLine,
  MAX_AGENT_TABS,
  navStateOf,
  normalizePreviewUrl,
  resolveRefFromSnapshot,
} from "../preview-logic";

describe("normalizePreviewUrl — address bar semantics", () => {
  it("passes full http(s) URLs through verbatim (trimmed)", () => {
    expect(normalizePreviewUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(normalizePreviewUrl("  http://localhost:5000/app  ")).toBe("http://localhost:5000/app");
  });

  it("maps bare hosts to https (dotted hosts only)", () => {
    expect(normalizePreviewUrl("example.com")).toBe("https://example.com");
    expect(normalizePreviewUrl("example.com/path")).toBe("https://example.com/path");
    expect(normalizePreviewUrl("app.example.dev")).toBe("https://app.example.dev");
  });

  it("maps scheme-less localhost to http (v2: omnibox sends raw input, D3)", () => {
    // The old behavior-preserving pin rejected localhost:port as unreachable
    // because the renderer pre-normalized. With renderer raw input (v2), the
    // unreachable localhost branch is now real: localhost → http per
    // ARCHITECTURE §2.
    expect(normalizePreviewUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizePreviewUrl("localhost/app")).toBe("http://localhost/app");
    expect(normalizePreviewUrl("localhost")).toBe("http://localhost");
    expect(normalizePreviewUrl("LOCALHOST:5173")).toBe("http://LOCALHOST:5173");
  });

  it("turns non-URL text into a real Google search", () => {
    expect(normalizePreviewUrl("react hooks docs")).toBe(
      "https://www.google.com/search?q=react%20hooks%20docs"
    );
    expect(normalizePreviewUrl("next.js 16")).toBe(
      "https://www.google.com/search?q=next.js%2016"
    );
  });

  it("returns null for empty or unsalvageable input", () => {
    expect(normalizePreviewUrl("")).toBeNull();
    expect(normalizePreviewUrl("   ")).toBeNull();
    expect(normalizePreviewUrl("!!")).toBeNull(); // fails the search-shape test too
    expect(normalizePreviewUrl(undefined as unknown as string)).toBeNull();
  });
});

describe("computeBounds — the view never paints outside or at zero size", () => {
  it("clamps negative origins to the window edge", () => {
    expect(computeBounds({ x: -40, y: -10, width: 800, height: 600 })).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  it("raises a degenerate 0/negative size to the 1px floor", () => {
    expect(computeBounds({ x: 10, y: 10, width: 0, height: -5 })).toEqual({
      x: 10,
      y: 10,
      width: 1,
      height: 1,
    });
  });

  it("rounds fractional renderer rects instead of rejecting them", () => {
    expect(computeBounds({ x: 12.6, y: 80.2, width: 799.4, height: 600.7 })).toEqual({
      x: 13,
      y: 80,
      width: 799,
      height: 601,
    });
  });
});

describe("resolveRefFromSnapshot — find refs resolve or fail loudly", () => {
  const snapshot = [
    { selector: "#login", description: 'button "Log in"' },
    { selector: "main > form > input", description: 'textbox "Email"' },
    { selector: "[data-testid='submit']", description: 'button "Submit"' },
  ];

  it("resolves e1..eN to the stored selectors", () => {
    expect(resolveRefFromSnapshot(snapshot, "e1").selector).toBe("#login");
    expect(resolveRefFromSnapshot(snapshot, "e3").selector).toBe("[data-testid='submit']");
  });

  it("accepts uppercase refs (e2 and E2 are the same element)", () => {
    expect(resolveRefFromSnapshot(snapshot, "E2").selector).toBe("main > form > input");
  });

  it("errors on a stale snapshot (page navigated since find)", () => {
    const r = resolveRefFromSnapshot(null, "e1");
    expect(r.error).toBe("ref e1 is stale — run browser_find again (no find snapshot)");
    expect(r.selector).toBeUndefined();
  });

  it("errors on out-of-range and non-numeric refs instead of guessing", () => {
    expect(resolveRefFromSnapshot(snapshot, "e4")?.error).toMatch(/unknown ref e4/);
    expect(resolveRefFromSnapshot(snapshot, "e0")?.error).toMatch(/unknown ref e0/);
    expect(resolveRefFromSnapshot(snapshot, "ex")?.error).toMatch(/unknown ref ex/);
  });
});

describe("formatConsoleLine — the agent's console observation", () => {
  it("formats the Electron ≥32 MessageDetails shape with a short source tail", () => {
    expect(
      formatConsoleLine({ level: "error", message: "boom", lineNumber: 42, sourceId: "/app/bundle/dist/deep.js" })
    ).toEqual({ level: "error", text: "boom (deep.js:42)" });
  });

  it("keeps plain messages bare and tolerates missing fields", () => {
    expect(formatConsoleLine({ level: "log", message: "hello" })).toEqual({ level: "log", text: "hello" });
    expect(formatConsoleLine(undefined)).toEqual({ level: "log", text: "" });
    expect(formatConsoleLine({})).toEqual({ level: "log", text: "" });
  });
});

describe("filterFindMatches — the ref space the agent sees", () => {
  const raw = [
    { role: "link", name: "Docs", selector: "a[href='/docs']", enabled: true },
    { role: "button", name: "Submit form", selector: "button.submit", enabled: true },
    { role: "textbox", name: "Email", selector: "input#email", enabled: true },
    { role: "button", name: "Cancel", selector: "button.cancel", enabled: false },
  ];

  it("filters by role when asked", () => {
    expect(filterFindMatches(raw, { role: "button" }).map((m) => m.name)).toEqual([
      "Submit form",
      "Cancel",
    ]);
  });

  it("matches the needle against name OR selector, case-insensitively", () => {
    expect(filterFindMatches(raw, { text: "email" }).map((m) => m.selector)).toEqual(["input#email"]);
    expect(filterFindMatches(raw, { text: "input#email" }).map((m) => m.name)).toEqual(["Email"]);
  });

  it("returns everything (capped) without a filter", () => {
    expect(filterFindMatches(raw)).toHaveLength(4);
    const many = Array.from({ length: 60 }, (_, i) => ({
      role: "button",
      name: `b${i}`,
      selector: `#b${i}`,
      enabled: true,
    }));
    expect(filterFindMatches(many)).toHaveLength(40);
  });
});

describe("lifecycle constants", () => {
  it("keeps the agent tab cap and named viewports as shipped", () => {
    expect(MAX_AGENT_TABS).toBe(4);
    expect(AGENT_VIEWPORTS.desktop).toEqual({ width: 1280, height: 720 });
    expect(AGENT_VIEWPORTS.tablet).toEqual({ width: 768, height: 1024 });
    expect(AGENT_VIEWPORTS.mobile).toEqual({ width: 390, height: 844 });
  });
});

describe("wait-for clamps", () => {
  it("fixed delay: default 1s, bounded 100ms..10s", () => {
    expect(clampFixedDelayMs(undefined)).toBe(1000);
    expect(clampFixedDelayMs("50")).toBe(100); // below floor
    expect(clampFixedDelayMs(99_999)).toBe(10_000); // above ceiling
    expect(clampFixedDelayMs(2_500)).toBe(2_500);
  });

  it("wait timeout: default 10s, bounded 500ms..15s", () => {
    expect(clampWaitTimeoutMs(undefined)).toBe(10_000);
    expect(clampWaitTimeoutMs(1)).toBe(500); // below floor
    expect(clampWaitTimeoutMs(60_000)).toBe(15_000); // above ceiling
    expect(clampWaitTimeoutMs("8000")).toBe(8_000);
  });
});

describe("navStateOf — did-navigate state for the toolbar (v2 D15)", () => {
  it("reads canGoBack/canGoForward from the history object", () => {
    expect(navStateOf({ canGoBack: () => true, canGoForward: () => false })).toEqual({
      canGoBack: true,
      canGoForward: false,
    });
  });

  it("fails closed (no back/forward) for missing/throwing fns", () => {
    expect(navStateOf(null)).toEqual({ canGoBack: false, canGoForward: false });
    expect(navStateOf(undefined)).toEqual({ canGoBack: false, canGoForward: false });
    expect(navStateOf({ canGoBack: () => { throw new Error("gone"); }, canGoForward: () => true })).toEqual({
      canGoBack: false,
      canGoForward: false,
    });
  });
});
