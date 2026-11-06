// csp-single-source.test.ts — the policy must exist on its side of the line.
//
// The app used to ship TWO Content-Security-Policy headers: a static one from
// next.config.js and a different, request-aware one from src/proxy.ts. Browsers
// enforce multiple CSP headers as their INTERSECTION, so the effective policy
// was whatever the strictest line of two disagreeing files said — and neither
// file could be edited with a predictable result (the static one still listed
// fonts.googleapis.com after the fonts moved to self-hosted, while pinning
// frame-ancestors 'self' against the proxy's 'none').
//
// These tests pin the arrangement: src/lib/csp.ts is the only builder, and
// next.config.js must not set a policy header again. They also pin the
// connect-src allowlist, because it is now enumerated rather than a blanket
// `https:` — a missing entry there blocks every API call in the renderer.

// Module marker: keeps top-level names from colliding with the other
// __tests__ global scripts (ts-jest compiles per file, but identical globals
// across two script-mode files break the TS project).
export {};

import { readFileSync } from "fs";
import { join } from "path";

import { buildCsp, OFFLINE_PROBE_ORIGIN } from "@/lib/csp";

function directives(policy: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of policy.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...values] = trimmed.split(/\s+/);
    map.set(name, values.join(" "));
  }
  return map;
}

function connectSrc(policy: string): string {
  return directives(policy).get("connect-src") ?? "";
}

describe("buildCsp", () => {
  it("never ships unsafe-eval in production", () => {
    const policy = buildCsp({ isProd: true });
    expect(policy).not.toContain("unsafe-eval");
  });

  it("allows unsafe-eval in development only (bundler requirement)", () => {
    const policy = buildCsp({ isProd: false });
    expect(directives(policy).get("script-src")).toContain("'unsafe-eval'");
  });

  it("refuses framing and out-of-origin navigation/submission", () => {
    const d = directives(buildCsp({ isProd: true }));
    expect(d.get("frame-ancestors")).toBe("'none'");
    expect(d.get("base-uri")).toBe("'self'");
    expect(d.get("form-action")).toBe("'self'");
  });

  it("names the split-API origin when one is configured", () => {
    const connect = connectSrc(buildCsp({ isProd: true, apiOrigins: ["https://api.example.com/"] }));
    // Trailing slash is stripped: CSP sources must be bare origins.
    expect(connect).toContain("https://api.example.com");
    expect(connect).not.toContain("https://api.example.com/");
  });

  it("names EVERY distinct API origin and collapses duplicates", () => {
    // The browser calls the build-time base while the server prefers the
    // runtime one; when they differ, both must be reachable.
    const connect = connectSrc(
      buildCsp({
        isProd: true,
        apiOrigins: ["http://localhost:5010", "https://api.internal.example", "http://localhost:5010/", "", null, undefined],
      }),
    );
    expect(connect).toBe(
      "'self' http://localhost:5010 https://api.internal.example https://www.google.com",
    );
  });

  it("drops a malformed base instead of emitting an invalid directive", () => {
    // One unparseable source makes browsers discard the whole directive —
    // which would block every API call rather than just that origin.
    const connect = connectSrc(
      buildCsp({ isProd: true, apiOrigins: ["api.example.com", "not a url; script-src *"] }),
    );
    expect(connect).toBe("'self' https://www.google.com");
  });

  it("does not open connect-src to the whole web", () => {
    // The regression this test exists for: a bare `https:` token allows every
    // host on the internet, which is what the policy used to ship.
    const connect = connectSrc(
      buildCsp({ isProd: true, apiOrigins: ["https://api.example.com"] }),
    );
    expect(connect.split(/\s+/)).not.toContain("https:");
    expect(connect.split(/\s+/)).not.toContain("wss:");
    expect(connect).toContain("https://www.google.com");
  });

  it("keeps the offline-probe host in step with what OfflineBanner fetches", () => {
    const source = readFileSync(
      join(__dirname, "../../components/OfflineBanner.tsx"),
      "utf8",
    );
    const probe = /fetch\("(https?:\/\/[^"]+)"/.exec(source);
    expect(probe?.[1]).toBeTruthy();
    expect(new URL(probe![1]).origin).toBe(OFFLINE_PROBE_ORIGIN);
    expect(connectSrc(buildCsp({ isProd: true }))).toContain(OFFLINE_PROBE_ORIGIN);
  });

  it("allows the HMR socket in dev only", () => {
    const dev = connectSrc(buildCsp({ isProd: false }));
    const prod = connectSrc(buildCsp({ isProd: true }));
    expect(dev).toContain("ws://localhost:*");
    expect(dev).toContain("ws://127.0.0.1:*");
    // The renderer opens no socket in production, and streaming is same-origin.
    expect(prod).not.toContain("ws://");
    expect(prod).not.toContain("wss:");
  });

  it("never references a font CDN — fonts are self-hosted", () => {
    const policy = buildCsp({ isProd: true, apiOrigins: ["https://api.example.com"] });
    expect(policy).not.toContain("fonts.googleapis.com");
    expect(policy).not.toContain("fonts.gstatic.com");
    // ...and the local font pipeline still fits in font-src.
    expect(directives(policy).get("font-src")).toBe("'self' data:");
  });

  it("keeps http loopback frames for dev, https-only for production", () => {
    const dev = directives(buildCsp({ isProd: false }));
    const prod = directives(buildCsp({ isProd: true }));
    expect(dev.get("frame-src")).toContain("http://127.0.0.1:*");
    expect(prod.get("frame-src")).not.toContain("http://");
  });

  it("declares each directive exactly once", () => {
    const names = buildCsp({ isProd: true, apiOrigins: ["https://api.example.com"] })
      .split(";")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
    expect(names.length).toBe(new Set(names).size);
  });
});

describe("next.config.js no longer carries a policy", () => {
  type HeaderGroup = { source: string; headers: Array<{ key: string; value: string }> };
  const config = require("../../../next.config.js") as {
    headers: () => Promise<HeaderGroup[]>;
  };

  async function headerMap(): Promise<Map<string, string>> {
    const groups = await config.headers();
    const map = new Map<string, string>();
    for (const group of groups) {
      for (const header of group.headers) map.set(header.key.toLowerCase(), header.value);
    }
    return map;
  }

  it("sets no Content-Security-Policy header of its own", async () => {
    // A second policy here is enforced as an intersection with the proxy's —
    // i.e. silently, and with no way to tell which file won.
    expect((await headerMap()).has("content-security-policy")).toBe(false);
  });

  it("keeps X-Frame-Options aligned with frame-ancestors 'none'", async () => {
    expect((await headerMap()).get("x-frame-options")).toBe("DENY");
  });

  it("still sets the unrelated security headers", async () => {
    const headers = await headerMap();
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("strict-transport-security")).toContain("max-age=");
  });
});
