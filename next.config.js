/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== "production";

const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  compress: true,
  // The bottom-corner "dev" badge overlaps the composer area in screenshots —
  // errors are still surfaced by the overlay/console, so hide the badge.
  devIndicators: false,
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        // Security headers
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
        { key: "X-XSS-Protection", value: "1; mode=block" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        {
          key: "Content-Security-Policy",
          value: `default-src 'self'; script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://openrouter.ai https://integrate.api.nvidia.com https://api.minimax.io wss:; img-src 'self' data: https:; frame-ancestors 'self';`,
        },
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
