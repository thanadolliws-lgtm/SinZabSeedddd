import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cache Components: every page is a static shell + per-user content streamed
  // behind <Suspense>. Nothing user-specific is ever cached (no `use cache`).
  cacheComponents: true,
  partialPrefetching: true,
  // Loaded from node_modules at runtime: PGlite ships a WASM binary next to its
  // JS, and node-postgres uses native Node sockets. Neither can be bundled.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  // The SQL migrations are read at runtime when the in-memory database starts
  // (Google Sheets mode): ship them with every server function.
  outputFileTracingIncludes: {
    "/*": ["./db/migrations/**/*.sql"],
  },
  poweredByHeader: false,
  async redirects() {
    return [{ source: "/", destination: "/overview", permanent: false }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
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
