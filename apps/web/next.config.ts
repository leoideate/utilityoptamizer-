import path from "node:path";
import type { NextConfig } from "next";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://127.0.0.1:4000";

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
        ],
      },
    ];
  },
  transpilePackages: ["@uo/shared"],
  outputFileTracingRoot: path.join(__dirname, "../.."),
  poweredByHeader: false,
  // Self-contained server bundle for the Docker image (apps/web/Dockerfile).
  output: "standalone",
};

export default nextConfig;
