/** @type {import('next').NextConfig} */
const nextConfig = {
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
