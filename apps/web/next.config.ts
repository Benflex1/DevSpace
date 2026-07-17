import type { NextConfig } from "next";

interface WebpackConfiguration {
  readonly externals: unknown[];
  readonly resolve: { extensionAlias?: Record<string, string[]> };
}

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "@devspace/database"],
  webpack(config: WebpackConfiguration) {
    config.externals.push({ "@devspace/database": "commonjs @devspace/database" });
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"]
    };
    return config;
  },
  headers() {
    return Promise.resolve([{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }
      ]
    }]);
  }
};

export default nextConfig;
