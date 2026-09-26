// ui-paths.ts — Shared heuristic: does this set of touched paths look like
// UI work? Both agent loops (browser worker + server executor) use it to
// decide whether browser verification is worth a dev-server boot.

export function looksLikeUiWork(paths: string[]): boolean {
  return paths.some((p) => {
    const lower = p.replace(/\\/g, "/").toLowerCase();
    if (/\.(tsx|jsx|html|css|scss|vue|svelte)$/.test(lower)) return true;
    // Next.js / Nuxt / SvelteKit app-router dirs signal pages even for .ts files
    return /(^|\/)(app|pages|components|views|screens)\//.test(lower);
  });
}

/** Port for the verification dev server — uncommon; skipped if occupied. */
export const BROWSER_VERIFY_PORT = 4310;

/**
 * Pick a dev command that matches the project: Next.js → `npm run dev`,
 * Vite → `npx vite`, static index.html → `npx serve`, else plain `npm run
 * dev` (failure surfaces honestly through the verify route). `port` is the
 * port the verify lane will probe — the static-serve command must bind it.
 */
export function pickDevCommand(pkgJson: string | null, hasStaticIndex: boolean, port: number = BROWSER_VERIFY_PORT): string {
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson);
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.next) return "npm run dev";
      if (deps.vite) return "npx vite";
    } catch {
      // unparseable package.json — fall through
    }
  }
  if (hasStaticIndex) return `npx serve -l ${port} .`;
  return "npm run dev";
}
