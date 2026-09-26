/**
 * embeddable.ts — client-safe URL helpers (no server-only imports).
 *
 * URLs that must bypass the /api/proxy and load directly in the iframe:
 * they send no X-Frame-Options AND their runtime JS needs their real origin.
 * YouTube watch/youtu.be/shorts pages are rewritten to the official /embed/
 * player, which is built for framing.
 */
export function embeddableUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
    if (host === "youtube.com") {
      if (u.pathname === "/watch") {
        const v = u.searchParams.get("v");
        if (v) return `https://www.youtube.com/embed/${v}`;
      }
      const shorts = u.pathname.match(/^\/shorts\/([\w-]+)/);
      if (shorts) return `https://www.youtube.com/embed/${shorts[1]}`;
      const live = u.pathname.match(/^\/live\/([\w-]+)/);
      if (live) return `https://www.youtube.com/embed/${live[1]}`;
      return null;
    }
    if (host === "youtu.be") {
      const id = u.pathname.slice(1);
      if (/^[\w-]{6,}$/.test(id)) return `https://www.youtube.com/embed/${id}`;
    }
    return null;
  } catch {
    return null;
  }
}
