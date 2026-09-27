/**
 * browser-proxy.test.ts — Cloudflare challenge detection for the embedded
 * browser. Uses a real captured challenge body shape (title + cf_chl_opt /
 * challenge-platform markers) plus false-positive guards: legitimate pages
 * that merely MENTION "just a moment" or quote CF docs must not trigger.
 */
import { isCloudflareChallenge, isProxiableUrl, proxiedUrl, proxiedResource, rewriteHtml } from "../browser-proxy";

const CF_TITLE = "<title>Just a moment...</title>";

function cfBody(markers = "window._cf_chl_opt = {}; challenge-platform/h/g/orchestrate/chl_page"): string {
  return `<!DOCTYPE html><html><head>${CF_TITLE}</head><body><script>${markers}</script></body></html>`;
}

describe("isCloudflareChallenge", () => {
  it("detects a real challenge via the Cf-Mitigated header (authoritative)", () => {
    expect(isCloudflareChallenge("<html></html>", { "cf-mitigated": "challenge" })).toBe(true);
  });

  it("detects via title + structural markers when the header is absent", () => {
    expect(isCloudflareChallenge(cfBody())).toBe(true);
    expect(isCloudflareChallenge(cfBody("__cf_chl_tk=abc"))).toBe(true);
    expect(isCloudflareChallenge(cfBody("/cdn-cgi/challenge-platform/h/b/orchestrate"))).toBe(true);
  });

  it("does not fire on title alone without a structural marker", () => {
    expect(isCloudflareChallenge(`<html><head>${CF_TITLE}</head><body>hello</body></html>`)).toBe(false);
  });

  it("does not fire on pages that merely mention the phrase (false positives)", () => {
    expect(isCloudflareChallenge("<html><body>Wait just a moment while we load your dashboard.</body></html>")).toBe(false);
    expect(isCloudflareChallenge('<html><head><title>Moment of clarity — blog</title></head><body>cf_chl_opt mentioned in text</body></html>')).toBe(false);
  });

  it("accepts plain header objects and Headers instances", () => {
    expect(isCloudflareChallenge("<html></html>", new Headers({ "Cf-Mitigated": "challenge" }))).toBe(true);
    expect(isCloudflareChallenge("<html></html>", new Headers())).toBe(false);
    expect(isCloudflareChallenge("<html></html>", undefined)).toBe(false);
  });
});

describe("proxy URL helpers", () => {
  it("isProxiableUrl allows only http(s)", () => {
    expect(isProxiableUrl("https://example.com/")).toBe(true);
    expect(isProxiableUrl("ftp://example.com/")).toBe(false);
    expect(isProxiableUrl("not a url")).toBe(false);
  });

  it("proxiedUrl wraps targets for page loads", () => {
    expect(proxiedUrl("https://example.com/a")).toBe("/api/proxy?url=https%3A%2F%2Fexample.com%2Fa");
  });

  it("proxiedResource wraps subresources with raw=1", () => {
    expect(proxiedResource("https://cdn.example.com/x.css")).toBe("/api/proxy?raw=1&url=https%3A%2F%2Fcdn.example.com%2Fx.css");
    expect(proxiedResource("ftp://cdn.example.com/x.css")).toBeNull();
  });
});

describe("rewriteHtml", () => {
  it("rewrites page links and strips framing-killers", () => {
    const html = `<html><head><base href="https://x.com/"><meta http-equiv="X-Frame-Options" content="DENY"></head><body><a href="/page">go</a><img src="http://cdn.example.com/i.png"></body></html>`;
    const out = rewriteHtml(html, "https://x.com/");
    expect(out).not.toContain("<base");
    expect(out).not.toContain("X-Frame-Options");
    expect(out).toContain("/api/proxy?url=");
    // http:// CDN assets get upgraded to https before wrapping.
    expect(out).toContain("https%3A%2F%2Fcdn.example.com");
  });

  it("leaves data: and fragment links untouched", () => {
    const html = `<html><body><a href="#top">top</a><img src="data:image/png;base64,AAA"></body></html>`;
    const out = rewriteHtml(html, "https://x.com/");
    expect(out).toContain('href="#top"');
    expect(out).toContain('src="data:image/png;base64,AAA"');
  });
});
