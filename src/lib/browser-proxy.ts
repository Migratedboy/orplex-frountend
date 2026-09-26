/**
 * browser-proxy.ts — server-side helpers for the embedded browser.
 *
 * The RightPanel preview is a real embedded browser: a same-origin proxy so
 * sites that send X-Frame-Options/CSP frame-ancestors still render, with
 * HTML rewritten so subresources and links keep working through the proxy.
 */
import * as cheerio from "cheerio";
import { embeddableUrl } from "./embeddable";

export { embeddableUrl };

const PROXY_BASE = "/api/proxy";

/** True for URLs the proxy refuses (internal metadata, non-web schemes). */
export function isProxiableUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Wrap any http(s) URL so it loads same-origin through /api/proxy. */
export function proxiedUrl(raw: string): string {
  return `${PROXY_BASE}?url=${encodeURIComponent(raw)}`;
}

/** Wrap a subresource (css/js/img) URL to stream through the proxy untouched. */
export function proxiedResource(raw: string, base?: string): string | null {
  try {
    const abs = new URL(raw, base).toString();
    if (!isProxiableUrl(abs)) return null;
    return `${PROXY_BASE}?raw=1&url=${encodeURIComponent(abs)}`;
  } catch {
    return null;
  }
}

/**
 * Rewrite an HTML document for the embedded browser:
 *  - <base> removed (links would escape the proxy)
 *  - a/href + form/action → proxied page loads
 *  - link/img/script/source/iframe srcs → proxied resource loads
 *  - meta CSP + X-Frame-Options kills stripped (page must render in-frame)
 *  - inline styles/preloads kept as-is (data:/blob:/#fragment untouched)
 */
export function rewriteHtml(html: string, pageUrl: string): string {
  const $ = cheerio.load(html);

  $("base").remove();
  $("meta[http-equiv='Content-Security-Policy' i]").remove();
  $("meta[http-equiv='X-Frame-Options' i]").remove();

  const rewriteAttr = (sel: string, attr: string, rawMode = false) => {
    $(sel).each((_, el) => {
      const val = $(el).attr(attr);
      if (!val) return;
      // Upgrade insecure absolute URLs (like real browsers do) — many sites
      // reference http:// CDN assets that their own CSP then blocks.
      const upgraded = val.replace(/^http:\/\/(?!localhost|127\.)/i, "https://");
      const v = upgraded.trim();
      if (
        !v ||
        v.startsWith("#") ||
        v.startsWith("data:") ||
        v.startsWith("blob:") ||
        v.startsWith("javascript:") ||
        v.startsWith("mailto:") ||
        v.startsWith("about:")
      ) {
        return;
      }
      const proxied = rawMode ? proxiedResource(v, pageUrl) : (() => {
        try {
          const abs = new URL(v, pageUrl).toString();
          return isProxiableUrl(abs) ? proxiedUrl(abs) : null;
        } catch {
          return null;
        }
      })();
      if (proxied) $(el).attr(attr, proxied);
    });
  };

  rewriteAttr("a[href]", "href");
  rewriteAttr("form[action]", "action");
  rewriteAttr("link[href]", "href", true);
  rewriteAttr("img[src]", "src", true);
  rewriteAttr("img[srcset]", "srcset", true);
  rewriteAttr("source[src]", "src", true);
  rewriteAttr("source[srcset]", "srcset", true);
  rewriteAttr("script[src]", "src", true);
  rewriteAttr("iframe[src]", "src");
  rewriteAttr("video[src]", "src", true);
  rewriteAttr("audio[src]", "src", true);
  rewriteAttr("video[poster]", "poster", true);

  return $.html();
}
