/** @type {import('next').NextConfig} */
const nextConfig = {
  // Serverless bundlers strip non-.js files from node_modules; Playwright
  // CANNOT launch without playwright-core/browsers.json (its browser
  // registry). This pins the whole package into every traced route bundle.
  outputFileTracingIncludes: {
    '/api/agent/browser': ['./node_modules/playwright-core/**'],
    '/api/agent/verify': ['./node_modules/playwright-core/**'],
  },
  poweredByHeader: false,
  reactStrictMode: true,
  compress: true,
  // API-only app: no page bundle shipping. CORS + CSRF live in proxy.ts.
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        // CORS headers are handled dynamically in src/proxy.ts
        // (static headers can't handle multi-origin comma-separated lists)
      ],
    },
  ],
};

module.exports = nextConfig;
