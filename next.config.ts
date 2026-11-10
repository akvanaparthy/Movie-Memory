import type { NextConfig } from "next";

// Cache Components is deliberately not enabled. Every page here depends on
// the session, and with it on, a session read always streams behind a
// Suspense boundary: a signed-out visitor to /dashboard got a 200 and a
// client-side redirect. Without it these pages render per request and
// `redirect()` is a real HTTP 307 sent before any HTML.
const nextConfig: NextConfig = {
  images: {
    // Google profile photos are the only remote images the app renders.
    remotePatterns: [
      { protocol: "https", hostname: "*.googleusercontent.com" },
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // The app is never meant to be framed (clickjacking). The CSP
          // directive is the current standard; X-Frame-Options covers
          // browsers that predate it.
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
