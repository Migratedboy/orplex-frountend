/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  compress: true,
  productionBrowserSourceMaps: false,
  // The desktop dev app loads the UI from 127.0.0.1 (explicit IPv4 loopback),
  // so module-script requests carry Origin: http://127.0.0.1:5000 — without
  // this entry the dev server 403s them and every dynamic(ssr:false) chunk
  // hangs forever on its skeleton fallback.
  allowedDevOrigins: ["127.0.0.1"],
  // Self-contained server bundle. This is what the PACKAGED desktop app runs
  // (.next/standalone/server.js): electron-builder then ships only the traced
  // production deps instead of the whole monorepo node_modules tree, which is
  // both far smaller and dramatically faster to package.
  output: "standalone",
  // Native/heavy deps must stay OUT of the traced bundle: they ship their own
  // binaries and are loaded lazily at runtime (or not at all in the desktop
  // UI, which proxies /api to the cloud backend).
  serverExternalPackages: [
    "@prisma/client",
    "prisma",
    "@prisma/engines",
    ".prisma",
    "playwright",
    "playwright-core",
    "@huggingface/transformers",
    "better-sqlite3",
    "electron",
  ],
  // The bottom-corner "dev" badge overlaps the composer area in screenshots —
  // errors are still surfaced by the overlay/console, so hide the badge.
  devIndicators: false,
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        // Security headers. There is deliberately NO Content-Security-Policy
        // here: the policy is built per-request in src/lib/csp.ts and set by
        // src/proxy.ts, the only layer that knows the split-API origin. A
        // second static policy here was enforced as an INTERSECTION with that
        // one, so the two drifted silently and neither could be edited with a
        // predictable effect.
        { key: "X-Content-Type-Options", value: "nosniff" },
        // Matches the policy's frame-ancestors 'none' — the app is never
        // framed by anyone, itself included. (SAMEORIGIN here used to
        // contradict the header the proxy set.)
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-XSS-Protection", value: "1; mode=block" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        // CORS headers are now handled dynamically in src/proxy.ts
        // (static headers can't properly handle multi-origin comma-separated lists)
      ],
    },
  ],
};

module.exports = nextConfig;
