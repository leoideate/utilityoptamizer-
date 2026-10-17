import path from "node:path";
import type { NextConfig } from "next";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://127.0.0.1:4000";
const PROD = process.env.NODE_ENV === "production";
/** Where signed document links point (S3 / MinIO), so previews can load. Space-separated; set at build time. */
const STORAGE_ORIGIN = process.env.STORAGE_ORIGIN ?? "http://127.0.0.1:8333 http://localhost:8333";

/**
 * Content-Security-Policy. Next.js inlines its hydration scripts, so scripts need 'unsafe-inline'
 * (no third-party script origins are allowed); development also needs 'unsafe-eval' for fast refresh.
 */
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${PROD ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${STORAGE_ORIGIN}`,
  "font-src 'self' data:",
  `connect-src 'self'${PROD ? "" : " ws: wss:"}`,
  `frame-src 'self' blob: ${STORAGE_ORIGIN}`,
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // The browser only ever talks to this origin; /api is proxied to the NestJS API,
  // so session cookies stay first-party and no CORS is needed.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: CSP },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          // Browsers ignore HSTS over plain HTTP, so it's safe to always send in production builds.
          ...(PROD ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
        ],
      },
    ];
  },
  // AWC UI (Material Design 3 web components) ships ESM with "use client" wrappers.
  transpilePackages: ["@uo/shared", "@awc-ui/react", "@awc-ui/core"],
  outputFileTracingRoot: path.join(__dirname, "../.."),
  poweredByHeader: false,
  // Self-contained server bundle for the Docker image (apps/web/Dockerfile).
  output: "standalone",
};

export default nextConfig;
